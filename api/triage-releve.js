// =====================================================================
// /api/triage-releve - Analyse IA d'un releve d'heures
// =====================================================================
// POST { releve_id: number }
// Returns: { verdict, confidence, summary, flags, analyzed_at, model }
//
// Etapes :
//   1. Verifie JWT admin (seuls les admins peuvent declencher l'analyse)
//   2. Charge le releve depuis Supabase (avec service role pour bypass RLS)
//   3. Compose un prompt structure avec tout le contenu du releve
//   4. Appelle Anthropic API (claude-haiku-4-5-20251001 : rapide et bon marche)
//   5. Parse la reponse JSON, met a jour ia_triage + statut si "ok"
//   6. Retourne le verdict
//
// Variables env requises (Vercel) :
//   - SUPABASE_URL                  : URL Supabase
//   - SUPABASE_SERVICE_ROLE_KEY     : Service role (jamais expose au client)
//   - SUPABASE_ANON_KEY             : Anon key (requise par /auth/v1/user pour valider le JWT)
//   - ANTHROPIC_API_KEY             : sk-ant-...
// =====================================================================

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_MAX_TOKENS = 600;

const SYSTEM_PROMPT = `Tu es un assistant qui aide un responsable d'exploitation a trier les releves d'heures journaliers de ses sondeurs (entreprise de forage en Nouvelle-Caledonie).

Pour chaque releve, retourne UNIQUEMENT un JSON valide (pas de texte autour) avec cette structure exacte :

{
  "verdict": "ok" | "review" | "alert",
  "confidence": 0.0 a 1.0,
  "summary": "Phrase courte (max 100 caracteres) decrivant le releve",
  "flags": [
    {"type": "categorie", "description": "explication courte"}
  ]
}

REGLES DE DECISION :
- "ok" : releve normal, rien d'inhabituel. Verdict majoritaire (~80% des cas).
- "review" : 1 ou 2 elements meritent un oeil de l'admin (heures un peu basses, remarque ambigue, pause longue, ecart vs prevu...).
- "alert" : 1 element grave (panne signalee, incident securite, retard important, anomalie horaire flagrante, pertes/casses anormales...).

TYPES DE FLAGS POSSIBLES :
- "panne" : equipement en panne signale dans remarques
- "securite" : incident, blessure, danger signale
- "heures_anormales" : total heures < 4h ou > 12h
- "pause_longue" : pause > 2h
- "demande_materiel" : sondeur demande quelque chose
- "absence" : membre d'equipe absent ou inhabituel
- "casse_consommable" : casse / perte excessive
- "retard" : arrivee tardive ou depart anticipe injustifie
- "remarque_libre" : remarque texte qui necessite une lecture humaine
- "autre" : autre point a signaler

Reste FACTUEL et CONCIS. Ne sois pas alarmiste sur du normal.`;

function buildUserPrompt(releve, contexte) {
  const lines = [];
  lines.push('RELEVE A ANALYSER:');
  lines.push('');
  lines.push('Date: ' + (releve.date_releve || '?'));
  lines.push('Sondeuse: ' + (contexte.sondeuse_code || releve.sondeuse_code || '?'));
  lines.push('Chantier: ' + (contexte.chantier_titre || '?'));
  lines.push('Sondeur: ' + (contexte.sondeur_nom || '?'));
  lines.push('Quart: ' + (releve.quart || '?'));
  lines.push('');
  if (releve.heure_debut || releve.heure_fin) {
    lines.push('Horaires: ' + (releve.heure_debut || '?') + ' -> ' + (releve.heure_fin || '?'));
    if (releve.total_heures != null) lines.push('Total heures: ' + releve.total_heures);
  }
  if (releve.horametre_debut != null || releve.horametre_fin != null) {
    lines.push('Horametre: ' + (releve.horametre_debut || '?') + ' -> ' + (releve.horametre_fin || '?'));
  }
  if (Array.isArray(releve.equipe) && releve.equipe.length > 0) {
    lines.push('Equipe: ' + releve.equipe.map(function(m) { return (m.nom || '?') + (m.role ? ' (' + m.role + ')' : ''); }).join(', '));
  }
  if (Array.isArray(releve.activites) && releve.activites.length > 0) {
    lines.push('');
    lines.push('Activites:');
    releve.activites.forEach(function(a) {
      lines.push('  - ' + (a.libelle || '?') + ' ' + (a.debut || '') + '->' + (a.fin || ''));
    });
  }
  if (Array.isArray(releve.sondages) && releve.sondages.length > 0) {
    lines.push('');
    lines.push('Sondages: ' + releve.sondages.length + ' (' + (releve.total_metres || 0) + ' m total)');
  }
  if (Array.isArray(releve.consommables_perdus) && releve.consommables_perdus.length > 0) {
    lines.push('');
    lines.push('Consommables perdus/casses:');
    releve.consommables_perdus.forEach(function(c) {
      lines.push('  - ' + (c.designation || c.nom || '?') + ' x' + (c.qty || c.quantite || 1));
    });
  }
  if (releve.remarques && String(releve.remarques).trim()) {
    lines.push('');
    lines.push('Remarques du sondeur:');
    lines.push('  "' + String(releve.remarques).trim() + '"');
  }
  lines.push('');
  lines.push('Analyse ce releve et retourne le JSON.');
  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const releveId = req.body && req.body.releve_id;
  if (!releveId) {
    return res.status(400).json({ error: 'releve_id manquant' });
  }

  // Verifie le JWT (admin uniquement)
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization manquant' });
  }
  const jwt = auth.slice(7);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SERVICE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!ANTHROPIC_KEY) missing.push('ANTHROPIC_API_KEY');
  if (missing.length > 0) {
    return res.status(500).json({
      error: 'Configuration serveur incomplete',
      missing_vars: missing,
      hint: 'Ajoute ces variables dans Vercel > Settings > Environment Variables puis redeploie'
    });
  }

  try {
    // 1. Verifie l'identite du caller via Supabase auth
    // /auth/v1/user requiert ANON_KEY comme apikey + JWT user en Bearer
    const meResp = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: ANON_KEY, Authorization: 'Bearer ' + jwt }
    });
    if (!meResp.ok) {
      const errText = await meResp.text();
      return res.status(401).json({
        error: 'Token invalide',
        supabase_status: meResp.status,
        supabase_response: errText.slice(0, 500),
        hint: 'Verifier que SUPABASE_ANON_KEY correspond bien au meme projet que SUPABASE_URL. JWT length = ' + jwt.length
      });
    }
    const me = await meResp.json();
    // Verifier que l'user est admin (lookup dans la table users)
    const userResp = await fetch(SUPABASE_URL + '/rest/v1/users?id=eq.' + me.id + '&select=role,is_admin', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const userArr = await userResp.json();
    const isAdmin = Array.isArray(userArr) && userArr[0] && (userArr[0].is_admin === true || userArr[0].role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ error: 'Reserve aux admins' });
    }

    // 2. Charge le releve avec contexte (chantier, sondeur)
    const releveResp = await fetch(
      SUPABASE_URL + '/rest/v1/releves_heures?id=eq.' + releveId + '&select=*',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } }
    );
    const releveArr = await releveResp.json();
    if (!Array.isArray(releveArr) || releveArr.length === 0) {
      return res.status(404).json({ error: 'Releve introuvable' });
    }
    const releve = releveArr[0];

    // Contexte additionnel : chantier, sondeur
    const contexte = {};
    if (releve.chantier_id) {
      const chResp = await fetch(SUPABASE_URL + '/rest/v1/chantiers?id=eq.' + releve.chantier_id + '&select=titre', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
      const chArr = await chResp.json();
      if (chArr[0]) contexte.chantier_titre = chArr[0].titre;
    }
    if (releve.personnel_id) {
      const pResp = await fetch(SUPABASE_URL + '/rest/v1/personnel?id=eq.' + releve.personnel_id + '&select=prenom,nom', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
      const pArr = await pResp.json();
      if (pArr[0]) contexte.sondeur_nom = ((pArr[0].prenom || '') + ' ' + (pArr[0].nom || '')).trim();
    }

    // 3. Appelle Claude API
    const userPrompt = buildUserPrompt(releve, contexte);
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      return res.status(502).json({ error: 'Anthropic API error', detail: errText.slice(0, 500) });
    }

    const claudeData = await claudeResp.json();
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';

    // Parse JSON de la reponse (Claude doit retourner du JSON pur, mais on est robuste)
    let verdict;
    try {
      // Extraire le 1er bloc { ... }
      const start = rawText.indexOf('{');
      const end = rawText.lastIndexOf('}');
      if (start < 0 || end < 0) throw new Error('Pas de JSON dans la reponse');
      verdict = JSON.parse(rawText.slice(start, end + 1));
    } catch (e) {
      // Fallback : on stocke la reponse brute pour debug, verdict review par defaut
      verdict = {
        verdict: 'review',
        confidence: 0.0,
        summary: 'Erreur parsing IA, lecture humaine requise',
        flags: [{ type: 'autre', description: 'Reponse non parseable : ' + rawText.slice(0, 200) }]
      };
    }

    // 4. Stocke dans ia_triage + maj statut si "ok"
    const triagePayload = Object.assign({}, verdict, {
      analyzed_at: new Date().toISOString(),
      model: ANTHROPIC_MODEL
    });

    const updateBody = { ia_triage: triagePayload };
    // Si verdict ok : auto-valide le releve (statut "approuvee")
    if (verdict.verdict === 'ok' && releve.statut === 'soumise') {
      updateBody.statut = 'approuvee';
    }

    const upResp = await fetch(SUPABASE_URL + '/rest/v1/releves_heures?id=eq.' + releveId, {
      method: 'PATCH',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(updateBody)
    });
    if (!upResp.ok) {
      const upErr = await upResp.text();
      return res.status(500).json({ error: 'Erreur sauvegarde Supabase', detail: upErr.slice(0, 500) });
    }

    return res.status(200).json({
      ok: true,
      releve_id: releveId,
      auto_validated: updateBody.statut === 'approuvee',
      triage: triagePayload
    });
  } catch (e) {
    return res.status(500).json({ error: 'Erreur interne', detail: (e && e.message) || String(e) });
  }
};
