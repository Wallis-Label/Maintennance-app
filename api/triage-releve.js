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

Un releve d'heures = pointage d'un employe pour sa journee. CHAMPS OBLIGATOIRES :
- Employe (nom)
- Sondeuse (code engin)
- Fonction
- Heure debut + heure fin

CHAMPS OPTIONNELS (leur absence n'est PAS une anomalie) :
- Chantier : info contextuelle, parfois absente
- Quart (jour/nuit) : pas toujours renseigne sur un releve d'heures
- Remarques : facultatives

Pour chaque releve, retourne UNIQUEMENT un JSON valide (pas de texte autour) :

{
  "verdict": "ok" | "review" | "alert",
  "confidence": 0.0 a 1.0,
  "summary": "Phrase courte (max 100 caracteres) decrivant le releve",
  "flags": [
    {"type": "categorie", "description": "explication courte"}
  ]
}

REGLES DE DECISION :
- "ok" : releve normal. Heures coherentes, pas de remarque preoccupante. C'est le verdict ATTENDU pour ~80% des cas. Un releve avec employe/sondeuse/horaires renseignes et pas de remarque grave = OK.
- "review" : element vraiment inhabituel mais pas urgent (pause > 2h, heures < 5h ou > 11h, remarque ambigue qui merite lecture humaine).
- "alert" : urgence reelle (panne foreuse signalee, incident securite, blessure, anomalie horaire flagrante < 4h ou > 12h, casse multiple/anormale).

NE FLAGGE JAMAIS :
- Absence de chantier (pas un champ obligatoire du releve)
- Absence de quart (pas un champ obligatoire du releve)
- Remarque vide (c'est le cas normal)
- Heures entre 5h et 11h (plage normale)
- Pause de 30 min - 2h (plage normale)

TYPES DE FLAGS POSSIBLES (si reellement anomalie) :
- "panne" : equipement en panne signale dans remarques
- "securite" : incident, blessure, danger signale
- "heures_anormales" : total < 4h ou > 12h
- "pause_longue" : pause > 2h
- "demande_materiel" : sondeur demande quelque chose d'urgent
- "absence" : equipe ou employe absent anormal
- "casse_consommable" : casse / perte vraiment excessive
- "retard" : arrivee tardive ou depart anticipe injustifie
- "remarque_libre" : remarque texte qui necessite une lecture humaine
- "autre" : autre point a signaler

Reste FACTUEL et CONCIS. Sois PERMISSIF par defaut : en cas de doute, mets "ok".`;

function buildUserPrompt(releve, contexte) {
  // Helper : n'ajoute la ligne que si la valeur est non vide.
  const lines = [];
  const add = function(label, val) {
    if (val == null) return;
    const s = String(val).trim();
    if (!s || s === '?' || s === '-' || s === 'null') return;
    lines.push(label + ': ' + s);
  };

  lines.push('RELEVE D\'HEURES A ANALYSER:');
  lines.push('');
  add('Date', releve.date_releve);
  add('Employe', contexte.sondeur_nom);
  add('Fonction', releve.fonction);
  add('Sondeuse', releve.sondeuse_code || contexte.sondeuse_code);
  add('Chantier (auxiliaire)', contexte.chantier_titre);
  add('Quart (auxiliaire)', releve.quart);
  if (releve.heure_debut || releve.heure_fin) {
    lines.push('Horaires: ' + (releve.heure_debut || '?') + ' -> ' + (releve.heure_fin || '?'));
  }
  add('Total minutes', releve.total_minutes);
  add('Pause dejeuner', releve.pause_dejeuner);
  add('Route chauffeur', releve.route_chauffeur);
  add('Route passager', releve.route_passager);
  add('Eloignement', releve.eloignement);
  add('Absence', releve.absence_type);
  add('Prime panier', releve.prime_panier);

  if (Array.isArray(releve.equipe) && releve.equipe.length > 0) {
    lines.push('');
    lines.push('Equipe: ' + releve.equipe.map(function(m) { return (m.nom || '?') + (m.role ? ' (' + m.role + ')' : ''); }).join(', '));
  }
  if (Array.isArray(releve.activites) && releve.activites.length > 0) {
    lines.push('');
    lines.push('Activites:');
    releve.activites.forEach(function(a) {
      lines.push('  - ' + (a.libelle || '?') + ' ' + (a.debut || '') + '->' + (a.fin || ''));
    });
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
  } else {
    lines.push('');
    lines.push('(Pas de remarques - cas normal)');
  }
  lines.push('');
  lines.push('Analyse ce releve d\'heures et retourne le JSON. Rappel: chantier et quart sont des champs auxiliaires, leur absence n\'est PAS une anomalie.');
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

  // Normalise SUPABASE_URL : retire d'eventuels suffixes /rest/v1, /auth/v1
  // ou trailing slash pour pouvoir concatener proprement les paths apres.
  let SUPABASE_URL = process.env.SUPABASE_URL || '';
  SUPABASE_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/auth\/v1\/?$/, '').replace(/\/$/, '');
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
    // Verifier que l'user est admin : lookup dans app_users par email,
    // role === "Administrateur" (la convention du projet, attention au grand A)
    const userEmail = (me.email || '').toLowerCase();
    const userResp = await fetch(SUPABASE_URL + '/rest/v1/app_users?email=ilike.' + encodeURIComponent(userEmail) + '&select=role,email', {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    });
    const userArr = await userResp.json();
    const isAdmin = Array.isArray(userArr) && userArr.some(function(u) { return u.role === 'Administrateur'; });
    if (!isAdmin) {
      return res.status(403).json({
        error: 'Reserve aux admins',
        debug: { user_email: userEmail, matched_users: userArr, hint: 'Verifier que ton email est dans app_users avec role = "Administrateur"' }
      });
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
    // Si verdict ok : auto-valide le releve (statut "valide_admin")
    // Convention du projet : en_attente -> valide_admin (avec valide_at timestamp)
    if (verdict.verdict === 'ok' && (releve.statut === 'en_attente' || releve.statut == null)) {
      updateBody.statut = 'valide_admin';
      updateBody.valide_at = new Date().toISOString();
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
