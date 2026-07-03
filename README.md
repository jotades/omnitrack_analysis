# Jota Interactive Dashboard

Dashboard responsive per analisi sessioni JSON `pp_*`, con backend Python/FastAPI e frontend React/Recharts.

La struttura è pensata per sostituire il notebook `ipywidgets + matplotlib` e preparare l'integrazione futura con una dashboard realtime.

## Cosa include

- Lettura automatica di cartelle `pp_00_sessions`, `pp_01_sessions`, ecc.
- Dropdown paziente, task/condition, fase `learning/exploration`, path, sessione.
- Smoothing offline della traiettoria con parametro `alpha` senza alterare i dati originali.
- Overlay cooked realtime, es. `alpha = 0.4`.
- Grafici Recharts responsive con tooltip, brush e cursore sincronizzato sul tempo.
- Confronto tra utenti.
- Confronto `learning` vs `exploration`.
- Valutazione feedback: intensity over time, intensity vs distance, feedback events, distance thresholds.
- Metriche aggregate per sessione.

## Requisiti

- Python 3.10+
- Node.js 18+
- npm

## Avvio backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export DATA_DIR=/home/jota/Downloads/third_analysis_dataset/Pilot/pp_study
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Backend: <http://127.0.0.1:8000>
API docs: <http://127.0.0.1:8000/docs>

## Avvio frontend

Apri un secondo terminale:

```bash
cd frontend
npm install
npm run dev
```

Frontend: <http://127.0.0.1:5173>

## Configurazione dati

Il backend legge `DATA_DIR`. La cartella deve avere una struttura simile a:

```text
pp_study/
  pp_00_sessions/
    pp_00_2026-..._learning_..._path_A.json
  pp_01_sessions/
    pp_01_2026-..._exploration_..._path_A.json
```

## Note importanti su alpha

- `x/y/z` sono i dati cooked originali del JSON/Mongo.
- `x_plot/y_plot/z_plot` sono calcolati solo per il grafico 2D.
- `alpha` basso, ad esempio `0.15–0.25`, rende la traiettoria più liscia.
- `alpha = 0.4` permette di avvicinarsi alla traiettoria cooked realtime.
- `alpha = 1.0` disattiva lo smoothing offline.

## Integrazione futura realtime

L'app è già separata in:

- `backend/app/analysis.py`: logica di parsing, metriche e dataframe.
- `backend/app/main.py`: API REST.
- `frontend/src/api.ts`: client API.
- `frontend/src/components/*`: componenti dashboard.

Per collegarla alla dashboard realtime, puoi aggiungere endpoint websocket o SSE nel backend senza riscrivere la UI.
