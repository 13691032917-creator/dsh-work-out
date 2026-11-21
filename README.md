# dsh-work-out

An DSH Web plugin that adds an **Artifact timeline** panel to the left sidebar.
It lists every file produced across all conversations in one time-ordered feed,
and marks the ones that changed or disappeared after they were delivered.

## Where it lives

- Left sidebar → **Artifact timeline** (the stacked-sheets icon).
- The panel opens in the main column; the row shows as selected while it is open.

## What it lists

Three signals, all read from the durable Session logs across every
conversation:

| Badge | Source | Meaning |
| --- | --- | --- |
| **Delivered** | the `present` tool's `deliverables/presented` events | The model declared the file a deliverable. Keeps its description. |
| **Written** | successful `write` / `edit` / mutating `str_replace_editor` calls, and the Univer export tools (`univer_export`, `univer_print_pdf`) | The file was materially produced. Only document-like extensions count (`.md`, `.docx`, `.pptx`, `.pdf`, `.xlsx`, `.html`, images, archives, and similar); source code and `.univer` containers are skipped. A call whose result errored contributes nothing. |
| **Script** | document paths named inside `pwsh` / `bash` / `node` commands | Scripts produce Office documents too. A candidate is admitted only on disk evidence: the file exists and its mtime is at or after one of the commands that name it — so inputs, templates, typos, and failed commands stay out. |

The strongest signal wins: a path that was both written and delivered appears
once, as *Delivered*.

## Reading the list

Rows run newest first, grouped by calendar day (Today / Yesterday / dated).
Each row shows the extension, the name, the directory plus any description,
its source, its status, and its age.

| Colour | State | Meaning |
| --- | --- | --- |
| Green | Kept | Still on disk, unmodified since it was produced. |
| Amber | Changed | Still on disk, but written again after delivery. |
| Red | Deleted | No longer present at that path; the name is struck through. |

Status comes from a live `stat` of the recorded path resolved against that
conversation's working directory, cached for 15 seconds, so an edit or a
deletion shows up without re-reading any event log.

Hovering or keyboard-focusing a row reveals its actions:

- **Preview** — open the file inside DSH, in the right sidebar's document preview
  (the `dsh-resource://file/session/<id>/<path>` address the Host resolves
  against that conversation's workspace). Markdown, HTML, PDF, images, Office
  documents (`.doc`/`.docx`/`.ppt`/`.pptx`), spreadsheets
  (`.xlsx`/`.xls`/`.csv`/`.tsv`) and plain text render there; archives, media and
  the other binary containers are disabled with the reason in the tooltip.
- **Open** — hand the file to the Host desktop's default application.
- **Reveal** — show the file in Explorer / Finder.
- **Copy path** — copy the full absolute path.
- **Open the conversation** — jump to the conversation that produced it.

Open and reveal re-verify the path through the Host filesystem before the
desktop sees it — the same chain the built-in delivery cards use — and are
disabled with an explanation on deleted rows or Hosts without a desktop. The
toolbar filters by state and searches name, path, and conversation title.

## Configuration

Set on the plugin row in `cordis.patch.yml`:

| Key | Default | Effect |
| --- | --- | --- |
| `includeWritten` | `true` | Also list files produced by mutation tools, not only `present` declarations. |
| `statusTtlMs` | `15000` | How long a file status stays cached before it is re-checked. |
| `scanTtlMs` | `60000` | Reserved for the catalogue refresh interval. |

## Limits

- Only files a conversation recorded through `present` or a supported mutation
  tool are listed. A file created by a shell command is not tracked, because no
  structured record of its path exists in the log.
- Open and reveal need a serving Host with a desktop; on Headless or remote
  access the actions stay visible but disabled, with the reason in the tooltip.
- A conversation's artifacts leave the list when its own log is removed;
  archiving a conversation does not remove its log.
- The first scan after start reads every Session log and reports progress in the
  header; later reads only re-read logs whose revision changed.
- Relative recorded paths resolve against that conversation's working
  directory. The panel never writes, moves, or deletes anything.

## Install

```sh
dsh plugin --profile <name> add ./dsh-work-out
```

Or install the directory through **Plugins → Add plugin**. A restart is
required, because the bundle's Host and Client halves mount at boot.

## License

MIT
