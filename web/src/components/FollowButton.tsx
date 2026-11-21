import { useEffect, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { toast } from './ui';

export function FollowButton({ username, initial, small }: { username: string; initial: boolean; small?: boolean }) {
  const [on, setOn] = useState(initial);
  const [hover, setHover] = useState(false);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  useEffect(() => setOn(initial), [initial]);

  const toggle = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    try {
      await api(`/users/${username}/follow`, { method: on ? 'DELETE' : 'POST' });
      setOn(!on);
      qc.invalidateQueries({ queryKey: ['profile', username] });
      qc.invalidateQueries({ queryKey: ['feed', 'following'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const style = small ? { height: 32, padding: '0 14px', fontSize: 14 } : undefined;
  if (on) {
    return (
      <button
        className="btn btn-outline danger"
        style={{ ...style, minWidth: small ? 76 : 96 }}
        disabled={busy}
        onClick={toggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {hover ? '取消关注' : '已关注'}
      </button>
    );
  }
  return (
    <button className="btn btn-light" style={style} disabled={busy} onClick={toggle}>
      关注
    </button>
  );
}
