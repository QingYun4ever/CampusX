import { useEffect, type CSSProperties } from 'react';
import { TopBar } from '../components/ui';
import { CHANGELOG, markSeen, type ChangeKind } from '../lib/changelog';

const KIND: Record<ChangeKind, string> = { new: '新增', improve: '改进', fix: '修复' };

export function Changelog() {
  useEffect(markSeen, []);
  return (
    <>
      <TopBar back title="更新日志" sub={`当前版本 ${CHANGELOG[0].version}`} />
      <div className="changelog">
        {CHANGELOG.map((r, i) => (
          <section key={r.version} className="release enter" style={{ '--i': i } as CSSProperties}>
            <div className="release-rail">
              <span className={`release-dot ${i === 0 ? 'latest' : ''}`} />
            </div>
            <div className="release-body">
              <div className="release-head">
                <span className="release-ver">v{r.version}</span>
                {i === 0 && <span className="tag new">最新</span>}
                <time className="muted small">{r.date}</time>
              </div>
              <h2>{r.title}</h2>
              <ul>
                {r.changes.map(([k, t]) => (
                  <li key={t}>
                    <span className={`kind ${k}`}>{KIND[k]}</span>
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
