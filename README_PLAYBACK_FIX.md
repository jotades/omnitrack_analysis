# Jota dashboard playback fix

Questa versione aggiunge:

- playback globale con slider, play/pause, reset, velocità 0.25x–8x;
- tutti i grafici temporali si riempiono progressivamente fino al tempo del cursore;
- traiettoria 2D proporzionale alla stanza 8 m x 12 m, con opzione 12 m x 8 m;
- marker START, NOW, END sulla traiettoria;
- overlay 2D learning/exploration per lo stesso paziente, condition e path;
- controllo scala per singolo grafico: tight, auto Recharts, da 0.

File principali modificati:

- frontend/src/App.tsx
- frontend/src/components/PlaybackControls.tsx
- frontend/src/components/ChartScaleControls.tsx
- frontend/src/components/ChartFrame.tsx
- frontend/src/components/Trajectory2D.tsx
- frontend/src/components/TimeSeriesCharts.tsx
- frontend/src/components/Controls.tsx
- frontend/src/styles.css

Avvio:

```bash
cd /home/jota/Omnitrack/omnitrack_analysis/frontend
npm run dev
```

Se il link di vite è rotto:

```bash
node node_modules/vite/dist/node/cli.js --host 127.0.0.1 --port 5173
```
