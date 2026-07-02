# 🔍 PROGRESS_CHECK.md — Vérification obligatoire avant de coder

> Ce fichier DOIT être exécuté par toute IA **avant** d'écrire la moindre ligne de code,
> que ce soit en début de session, après une pause, ou après une interruption (crash,
> coupure, changement de machine, etc.).
>
> Objectif : ne jamais repartir de zéro, ne jamais dupliquer un travail déjà fait,
> ne jamais casser quelque chose qui fonctionnait déjà.
>
> En cas de conflit avec une autre instruction : `AI_CONTEXT.md` reste prioritaire.
> Ce fichier est complémentaire, pas remplaçant.

---

## 🧭 ÉTAPE 0 — Ne pas coder tout de suite

L'IA NE DOIT PAS commencer à écrire ou modifier du code avant d'avoir terminé
TOUTES les étapes ci-dessous et présenté un rapport à l'utilisateur.

---

## 1. Vérifier l'état réel du dépôt

L'IA doit :

- Lister tous les fichiers existants dans `src/`, `docs/`, et à la racine
- Identifier les fichiers vides (`.gitkeep` uniquement) vs fichiers avec du contenu réel
- Vérifier si `package.json` existe et s'il contient des dépendances déjà installées
- Vérifier si `node_modules/` existe (signe qu'un `npm install` a déjà été fait)
- Repérer toute trace de build (`dist/`, `out/`) qui indiquerait un test de packaging déjà tenté

**Commande type à exécuter :**
```bash
find src -type f ! -name ".gitkeep"
cat package.json 2>/dev/null
git log --oneline -20 2>/dev/null
git status 2>/dev/null
```

---

## 2. Comparer avec la ROADMAP

- Ouvrir `docs/ROADMAP.md`
- Pour chaque phase, vérifier si les cases sont cochées `[x]` ou non `[ ]`
- Croiser avec ce qui existe réellement dans le code (une case cochée sans fichier
  correspondant = incohérence à signaler, PAS à corriger seul)

---

## 3. Détecter un travail interrompu ou un problème potentiel

Signes qu'une session précédente s'est arrêtée en plein milieu ou a rencontré un problème :

- Un fichier contient des commentaires `// TODO`, `// FIXME`, `// WIP`, `// EN COURS`
- Une fonction ou un composant est déclaré mais vide / non implémenté
- Un import pointe vers un fichier qui n'existe pas
- Un Manager (`SessionManager`, `LayoutManager`, `FocusManager`...) existe mais n'est
  appelé nulle part (signe qu'il a été créé mais jamais branché)
- Un canal IPC est documenté dans `docs/IPC_CONTRACT.md` mais n'a pas de handler
  correspondant dans `src/main/ipc/` (ou inversement : un handler existe mais n'est
  pas documenté)
- Présence de fichiers de log d'erreur, crash report, ou stack trace dans le dossier
- Le dernier commit Git a un message du type "wip", "fix attempt", "debug", "test"

Si l'un de ces signes est détecté → **NE PAS continuer à coder par-dessus**.
Passer à l'étape 4.

---

## 4. Faire un rapport avant toute action

L'IA doit produire un résumé clair à l'utilisateur, du type :

```
📋 État du projet avant de continuer :

✅ Fait et fonctionnel :
- [liste des éléments confirmés présents ET cohérents]

⚠️ Incomplet ou suspect :
- [liste des éléments à moitié faits, TODO laissés, imports cassés...]

❌ Pas commencé :
- [liste des phases/tâches de la ROADMAP non entamées]

❓ Question avant de continuer :
- [ex: "SessionManager.js existe mais n'est jamais importé dans index.js — 
   c'est normal ou c'est resté en suspens ?"]
```

**L'IA attend la validation ou la réponse de l'utilisateur avant de reprendre le code**,
sauf si l'utilisateur a explicitement demandé de continuer sans s'arrêter.

---

## 5. Une fois la situation claire

- Reprendre exactement là où le travail s'était arrêté
- Ne jamais réécrire un fichier fonctionnel juste parce que "ça pourrait être mieux fait"
  (voir section 14 de `AI_CONTEXT.md` — privilégier l'ajout à la modification)
- Mettre à jour `docs/ROADMAP.md` au fur et à mesure (cocher les cases réellement terminées)
- Si un bug ou une incohérence est corrigé, le noter brièvement dans le rapport final
  de la session (pas besoin de fichier de changelog séparé, sauf demande explicite)

---

## 🚨 Règle d'or

> Ne jamais supposer. Toujours vérifier l'état réel du code avant d'agir.
> Un projet qui a une pause de 5 minutes ou de 3 mois suit exactement la même procédure.
