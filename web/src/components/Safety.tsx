/**
 * 举报弹窗、拉黑 / 取消拉黑。
 * 举报：帖子或用户，选原因 + 可选补充说明，管理员在后台处理。
 * 拉黑：互相取关；对方不能回复、赞、关注、私信你；你在时间线、吧、搜索里不再看到他。
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Modal, toast, useModalClose } from './ui';
import './safety.css';

export const REPORT_REASONS: { id: string; label: string; hint: string; user?: boolean; post?: boolean }[] = [
  { id: 'spam', label: '垃圾广告', hint: '刷屏、引流、推销' },
  { id: 'harass', label: '辱骂骚扰', hint: '人身攻击、恶意骚扰、引战' },
  { id: 'porn', label: '色情低俗', hint: '露骨、低俗的文字或图片' },
  { id: 'illegal', label: '违法违规', hint: '赌博、诈骗、暴力等' },
  { id: 'privacy', label: '泄露隐私', hint: '公开别人的照片、电话、住址等' },
  { id: 'fake', label: '冒充他人', hint: '假冒同学、老师或学校账号', post: false },
  { id: 'other', label: '其他', hint: '在下面写一写原因' },
];

function ReportForm({ targetType, targetId }: { targetType: 'post' | 'user'; targetId: number }) {
  const close = useModalClose();
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const reasons = REPORT_REASONS.filter((r) => (targetType === 'post' ? r.post !== false : r.user !== false));

  const submit = async () => {
    if (!reason) return;
    if (reason === 'other' && !note.trim()) return toast('选「其他」时请写一下原因', 'error');
    setBusy(true);
    try {
      await api('/reports', { body: { targetType, targetId, reason, note: note.trim() } });
      setDone(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="modal-body report-done">
        <ShieldCheck size={40} />
        <h3>已收到你的举报</h3>
        <p className="muted">管理员会尽快查看，处理后会通知你。举报是匿名的，对方不会知道是谁举报的。</p>
        <button className="btn btn-primary" onClick={close}>好的</button>
      </div>
    );
  }

  return (
    <div className="modal-body report-form">
      <p className="muted small">举报是匿名的。请选择最符合的一项：</p>
      <div className="report-reasons" role="radiogroup" aria-label="举报原因">
        {reasons.map((r) => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={reason === r.id}
            className="report-reason"
            onClick={() => setReason(r.id)}
          >
            <span>
              <b>{r.label}</b>
              <small>{r.hint}</small>
            </span>
            <i aria-hidden="true">{reason === r.id && <Check size={14} strokeWidth={3} />}</i>
          </button>
        ))}
      </div>
      <textarea
        className="report-note"
        rows={3}
        maxLength={300}
        placeholder={reason === 'other' ? '请写一下原因（必填）' : '补充说明（可选）'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="report-foot">
        <Link to="/help#report" className="faint small" onClick={close}>举报会怎么处理？</Link>
        <button className="btn btn-primary" disabled={!reason || busy} onClick={submit}>
          {busy ? '提交中…' : '提交举报'}
        </button>
      </div>
    </div>
  );
}

export function ReportDialog({ targetType, targetId, onClose }: { targetType: 'post' | 'user'; targetId: number; onClose: () => void }) {
  return (
    <Modal title={targetType === 'post' ? '举报帖子' : '举报用户'} onClose={onClose} className="report-modal">
      <ReportForm targetType={targetType} targetId={targetId} />
    </Modal>
  );
}

/** 拉黑 / 取消拉黑。返回新的状态；用户取消确认时返回 null */
export function useBlockToggle() {
  const qc = useQueryClient();
  return async (user: { username: string; displayName: string }, blocked: boolean): Promise<boolean | null> => {
    if (!blocked) {
      const ok = confirm(
        `拉黑 ${user.displayName}？\n\n· 你们会互相取消关注\n· 对方不能回复、赞你的帖子，也不能关注你、给你发私信\n· 你不会再在时间线、吧和搜索里看到对方\n\n随时可以在「设置 → 拉黑名单」里解除。`,
      );
      if (!ok) return null;
    }
    try {
      await api(`/users/${user.username}/block`, { method: blocked ? 'DELETE' : 'POST' });
      toast(blocked ? `已解除对 ${user.displayName} 的拉黑` : `已拉黑 ${user.displayName}`);
      qc.invalidateQueries();
      return !blocked;
    } catch (e) {
      toast((e as Error).message, 'error');
      return null;
    }
  };
}
