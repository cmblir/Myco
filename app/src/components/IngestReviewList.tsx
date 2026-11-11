import type { JSX } from "react";
import type { Lang } from "../lib/i18n";
import type { NodeMeta } from "../lib/ipc";
import { INTAKE_COPY } from "../lib/intakeCopy";
import { ingestReviewTitle, type IngestPageChange } from "../lib/ingestReview";
import { Icon } from "../lib/icons";

/** Only render for the originating vault opening; all paths come from run results. */
export default function IngestReviewList({ pages, root, sourcePath, meta, lang, onOpen }: {
  pages: IngestPageChange[];
  root: string;
  sourcePath?: string;
  meta?: Record<string, NodeMeta>;
  lang: Lang;
  onOpen: (path: string) => void;
}): JSX.Element {
  const copy = INTAKE_COPY[lang];
  return <section className="intake-review" data-testid="ingest-touched" aria-label={copy.changedNotes}>
    <h3>{copy.changedNotes} <span>{new Intl.NumberFormat(lang).format(pages.length)}</span></h3>
    <ul>
      {pages.map(page => <li key={page.path}>
        <button type="button" className="intake-review__note" onClick={() => onOpen(`${root}/${page.path}`)}>
          <Icon name="page" size={18} />
          <span className="intake-review__name">
            <strong>{ingestReviewTitle(page.path, meta?.[`${root}/${page.path}`]?.title)}</strong>
            <small>{page.path}</small>
          </span>
          <span className="intake-review__change">{copy[page.change]}</span>
          <Icon name="arrowR" size={16} />
        </button>
      </li>)}
    </ul>
    {sourcePath ? <button type="button" className="btn btn-ghost intake-review__source" onClick={() => onOpen(`${root}/${sourcePath}`)}>
      <Icon name="file" size={16} /><span>{copy.sourceOriginal}<small>{sourcePath}</small></span>
    </button> : null}
  </section>;
}
