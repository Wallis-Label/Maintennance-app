-- =====================================================================
-- Messages : forcer l'ajout des colonnes + reload du schema cache PostgREST
-- =====================================================================
-- L'erreur 'Could not find the destinataire_type column in schema cache'
-- persiste : soit le v2 n'a pas ete execute, soit le schema cache Supabase
-- n'a pas recharge. Ce script :
--  1) Diagnostic : liste les colonnes actuelles
--  2) Ajoute les colonnes si absentes (idempotent)
--  3) Force PostgREST a recharger le schema (NOTIFY pgrst)
--  4) Verification finale
-- =====================================================================

-- ─── 1) Diagnostic AVANT ───
SELECT 'AVANT' AS etape, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'messages'
ORDER BY ordinal_position;

-- ─── 2) Ajout des colonnes ───
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS destinataire_type text DEFAULT 'all';
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS destinataire_id bigint;

-- Backfill : messages existants
UPDATE public.messages
SET destinataire_type = 'all'
WHERE destinataire_type IS NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_dest_type ON public.messages(destinataire_type);
CREATE INDEX IF NOT EXISTS idx_messages_dest_id ON public.messages(destinataire_id);

-- ─── 3) FORCE le reload du schema cache PostgREST ───
-- C'est ce qui fait que Supabase / PostgREST "voit" les nouvelles colonnes
-- immediatement. Sans ca, il faut attendre ~10min ou redemarrer l'API.
NOTIFY pgrst, 'reload schema';

-- ─── 4) Verification APRES ───
SELECT 'APRES' AS etape, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'messages'
ORDER BY ordinal_position;

SELECT destinataire_type, COUNT(*) AS n
FROM public.messages
GROUP BY destinataire_type
ORDER BY n DESC;
