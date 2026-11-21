import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '../components/Logo';
import { Modal, toast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import './terms.css';

/**
 * 用户协议版本，和 server/src/config.ts 的 TERMS_VERSION 保持一致。
 * 有实质修改时两边一起加 1，并更新 TERMS_DATE；所有人下次打开会被请求重新确认。
 */
export const TERMS_VERSION = 1;
const TERMS_DATE = '2026 年 11 月 21 日';

/** 协议正文。写给同学看，尽量短、说人话 */
export function TermsBody() {
  return (
    <div className="terms">
      <p className="terms-lead">
        校墙是同学们交流的地方。为了让大家都待得舒服，请花两分钟看完下面几条。
      </p>

      <h3>1. 好好说话</h3>
      <p>不要发这些：</p>
      <ul>
        <li>辱骂、嘲讽、起侮辱性外号、孤立别人等霸凌行为</li>
        <li>别人的隐私：挂人、照片、联系方式、住址、聊天截图（本人同意的除外）</li>
        <li>色情、暴力、赌博、毒品等违法或不适合同学看的内容</li>
        <li>谣言、广告、刷屏，冒充同学或老师</li>
      </ul>
      <p>有分歧可以讲道理，但别人身攻击。</p>

      <h3>2. 你发的内容由你负责</h3>
      <ul>
        <li>你发布的帖子、回复、私信和图片，都由你本人负责。</li>
        <li>
          校墙用 AI 审核和管理员帮忙把关，但不可能拦住所有内容。
          <strong>内容通过了审核、没有被删除，不代表校墙认可它，也不会让责任转到校墙或管理员身上。</strong>
        </li>
        <li>用谐音、拆字、图片藏字、缩写等方式故意绕过审核，按情节严重处理。</li>
        <li>因你发布的内容引起的纠纷或法律责任，由你自己承担。</li>
      </ul>

      <h3>3. 违规会怎样</h3>
      <p>
        视情节删除内容、警告、限制发言或封禁账号。被审核拦下和删除的内容会留存记录，用于处理举报；
        涉及违法的，会配合学校和有关部门依法处理。
      </p>

      <h3>4. 账号</h3>
      <ul>
        <li>一人一个账号，不要借给别人或买卖。账号下的所有操作都视为你本人所为。</li>
        <li>保管好密码和恢复码。</li>
        <li>未满 14 周岁的同学，请在家长或监护人同意后使用。</li>
      </ul>

      <h3>5. 隐私</h3>
      <ul>
        <li>我们保存账号信息、你发布的内容和必要的登录记录，用来让校墙正常运行、保障安全，不会出售给任何人。</li>
        <li>开启内容审核时，你发布的文字和图片会发送给第三方 AI 服务检查。</li>
        <li>私信不会公开展示；处理举报或依法需要时，管理员可能查看相关记录。</li>
      </ul>

      <h3>6. 免责声明</h3>
      <ul>
        <li>用户发布的观点只代表他本人，不代表校墙。</li>
        <li>校墙按现状提供服务，可能因为维护或故障暂停，也可能丢失数据，重要内容请自己留底。</li>
        <li>站内的外部链接和第三方内容，校墙不保证其安全和准确。</li>
        <li>同学之间的矛盾和私下约定由当事人自行解决，管理员可以协助调解，但不承担责任。</li>
      </ul>

      <h3>7. 协议更新</h3>
      <p>协议有重要修改时，会在你打开校墙时请你重新确认。有疑问可以私信管理员。</p>

      <p className="terms-date">生效日期：{TERMS_DATE}</p>
    </div>
  );
}

/** 注册页里弹出来看，不离开当前步骤 */
export function TermsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="校墙用户协议" onClose={onClose} className="terms-modal">
      <div className="modal-body">
        <TermsBody />
      </div>
    </Modal>
  );
}

/** /terms：登录前后都能打开 */
export function TermsPage() {
  const nav = useNavigate();
  return (
    <div className="terms-page">
      <header>
        <button className="icon-btn" aria-label="返回" onClick={() => (window.history.state?.idx > 0 ? nav(-1) : nav('/'))}>
          <ArrowLeft size={20} />
        </button>
        <h1>校墙用户协议</h1>
      </header>
      <TermsBody />
    </div>
  );
}

/** 老用户、或者协议更新后：确认之前不能继续用 */
export function TermsGate() {
  const { user, setUser, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const agree = async () => {
    setBusy(true);
    try {
      await api('/me/terms', { method: 'POST', body: { version: TERMS_VERSION } });
      setUser({ ...user!, termsPending: false });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="terms-page terms-gate">
      <header>
        <Logo size={32} />
        <div>
          <h1>请先看一下用户协议</h1>
          <p>继续使用校墙之前，需要你确认同意。</p>
        </div>
      </header>
      <TermsBody />
      <footer>
        <button className="btn btn-text" onClick={() => void signOut()} disabled={busy}>
          退出登录
        </button>
        <button className="btn btn-primary" onClick={agree} disabled={busy}>
          {busy ? '请稍候…' : '我已阅读并同意'}
        </button>
      </footer>
    </div>
  );
}
