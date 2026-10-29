import { useEffect, useState } from 'react';
import { History, Undo2 } from 'lucide-react';
import { fetchChanges, undoChange, type ChangeEntry } from '../api';
import { useEditMode } from '../lib/editMode';

/** Header menu listing the corrections saved from the dashboard, with the
 * value they replaced, and an Undo for each (edit mode only). */
export function ChangesMenu({ onUndone }: { onUndone: () => void }) {
  const editMode = useEditMode();
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<ChangeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetchChanges(50).then(setChanges).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [open]);

  async function undo(entry: ChangeEntry) {
    if (!window.confirm(`Undo this change?\n\n${entry.summary}`)) return;
    setBusy(entry.id);
    try {
      await undoChange(entry.id);
      onUndone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="changesMenu">
      <button type="button" className="themeToggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <History size={17} />
        Changes
      </button>
      {open ? (
        <div className="changesPanel" role="dialog" aria-label="Saved corrections">
          <div className="changesPanelHead">
            <strong>Saved corrections</strong>
            <small>{editMode ? 'Newest first. Undo puts back the value the change replaced.' : 'Newest first. Turn on edit mode to undo a change.'}</small>
          </div>
          {error ? <p className="changesError">{error}</p> : null}
          {changes === null && !error ? <p className="miniHint">Loading…</p> : null}
          {changes && !changes.length ? <p className="miniHint">No corrections saved yet.</p> : null}
          <ul>
            {(changes ?? []).map((c) => (
              <li key={c.id} className={c.undone_by ? 'undone' : undefined}>
                <span className="changeTime">{c.time.replace('T', ' ')}</span>
                <span className="changeSummary">{c.summary}{c.undone_by ? ' (undone)' : ''}</span>
                {!c.undo_of && !c.undone_by ? (
                  <button type="button" disabled={!editMode || busy !== null} onClick={() => undo(c)} title={editMode ? 'Undo this change' : 'Turn on edit mode to undo'}>
                    <Undo2 size={14} /> Undo
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
