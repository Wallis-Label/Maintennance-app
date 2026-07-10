-- ============================================================
-- Suppression des donnees charges_fixes manuelles (Wallis-Label admin)
-- ------------------------------------------------------------
-- Les frais generaux viennent desormais 100% du FEC (grand livre, classe 6)
-- via computeFraisGenerauxFEC(). L'onglet "Charges fixes" a ete retire de
-- l'app ; la table manuelle n'est plus utilisee (fallback = 0 si FEC absent).
--
-- >>> A EXECUTER SUR LE PROJET SUPABASE **WALLIS-LABEL** (PAS COSMO) <<<
-- ============================================================

-- (Optionnel) verifier ce qui va etre supprime :
SELECT id, categorie, libelle, montant_mensuel, actif FROM public.charges_fixes;

-- OPTION B choisie : vider la table.
DELETE FROM public.charges_fixes;

-- La table reste en place (structure conservee), seules les lignes sont supprimees.
-- Si un jour tu veux supprimer la table entierement (elle n'est plus lue par l'app) :
-- DROP TABLE public.charges_fixes;
