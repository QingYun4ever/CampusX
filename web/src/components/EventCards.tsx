import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, PartyPopper, X } from 'lucide-react';
import { api, type CampusEvent } from '../lib/api';
import { eventMine, eventPerks, eventRefreshDelay, eventWhen } from '../lib/events';
import '../pages/events.css';

const DISMISS_KEY = 'txq_event_dismissed';
function readDismissed(): number[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
  } catch {
    return [];
  }
}

/** 首页顶部：正在进行和快开始的活动。可以关掉，关掉的不再显示 */
export function EventCards() {
  const [dismissed, setDismissed] = useState(readDismissed);
  const q = useQuery({
    queryKey: ['events', 'current'],
    queryFn: () => api<CampusEvent[]>('/events/current'),
    staleTime: 5 * 60_000,
    refetchInterval: (query) => eventRefreshDelay(query.state.data),
    refetchIntervalInBackground: true,
    retry: false,
  });
  const list = (q.data ?? []).filter((e) => !dismissed.includes(e.id));
  if (!list.length) return null;
  const dismiss = (id: number) => {
    const next = [id, ...dismissed].slice(0, 30);
    setDismissed(next);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
    } catch {
      /* 存不了就只在这次关掉 */
    }
  };
  return (
    <div className="event-cards">
      {list.map((e) => (
        <div key={e.id} className="event-card">
          <Link to={`/events/${e.id}`} className="event-card-main">
            <span className="event-card-icon"><PartyPopper size={18} /></span>
            <span className="event-card-text">
              <span className="event-card-head">
                <span className={`event-label ${e.status}`}>{e.status === 'upcoming' ? '即将开始' : '活动'}</span>
                <b className="ellipsis">{e.title}</b>
              </span>
              <span className="event-card-sub ellipsis">
                {/* 时间放前面：手机上一行放不下时被截掉的是后面的奖励说明 */}
                {eventWhen(e)} · {eventMine(e) ?? eventPerks(e).join(' · ')}
              </span>
            </span>
            <ChevronRight size={18} className="faint" />
          </Link>
          <button type="button" className="event-card-close" aria-label="不再显示这个活动" onClick={() => dismiss(e.id)}>
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
