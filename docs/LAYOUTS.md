# 🖥️ LAYOUTS — Spécification détaillée

> Complète la section 5 de `AI_CONTEXT.md`.

---

## 1. Définition

Un Layout est une configuration **purement visuelle** qui décrit comment les Sessions
existantes sont disposées dans la fenêtre. Le Layout ne possède aucune donnée de Session —
il référence uniquement des `sessionId`.

```ts
interface Layout {
  id: string;
  mode: "single" | "multi";
  slots: LayoutSlot[];      // zones d'affichage
}

interface LayoutSlot {
  sessionId: string | null; // null = slot vide
  position: { x: number; y: number; width: number; height: number };
}
```

---

## 2. Modes

### SINGLE MODE
- Une seule Session visible à l'écran, plein cadre.
- Les autres Sessions restent actives en arrière-plan.
- Bascule entre Sessions = changement de `slot.sessionId`, jamais de reconnexion.

### MULTI MODE
- Grille de N slots (2x2, 3x3, etc.).
- Chaque slot peut être vide ou occupé par une Session.
- Le redimensionnement de la grille ne touche jamais aux données de Session.

---

## 3. Règles strictes

1. **Un Layout ne crée ni ne détruit de Session.** Il ne fait que les positionner.
2. **Changer de Layout ne doit jamais interrompre un flux vidéo actif** — sauf si la Session
   sort de tous les slots visibles (elle continue alors en arrière-plan, non rendue).
3. **Le rendu vidéo (Canvas) est découplé du Layout.** Le Layout dit *où* afficher,
   le Canvas component s'occupe du *comment* (décodage, framerate, etc.).

---

## 4. Interaction avec le Focus

- Cliquer sur un slot dans un Layout MULTI met le Focus sur la Session de ce slot.
- Le Layout ne décide jamais lui-même du Focus — il ne fait que déclencher l'action
  via IPC (`focus:set(sessionId)`), gérée par `FocusManager`.
