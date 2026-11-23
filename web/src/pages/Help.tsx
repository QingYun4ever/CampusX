/**
 * 帮助：等级和经验、签到、表情、拉黑、举报。不用登录也能看（和隐私政策一样）。
 * 数值要和 server/src/levels.ts、routes/safety.ts 保持一致。
 */
import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { LevelBadge } from '../components/Level';
import './terms.css';
import './help.css';

const LEVEL_EXP = [0, 5, 15, 30, 50, 100, 200, 500, 1000, 2000, 3000, 4500, 6000, 8000, 10000, 13000, 18000, 25000];
const TITLES = ['新来的', '路过', '冒个泡', '常来', '混个脸熟', '熟面孔', '活跃分子', '中坚力量', '骨干', '老东西', '老油条', '老江湖', '镇吧之宝', '活化石', '吧中传说', '元老', '吧魂', '校墙传奇'];

const SECTIONS = [
  ['levels', '等级和经验'],
  ['emoji', '自定义表情'],
  ['block', '拉黑'],
  ['report', '举报'],
] as const;

export function HelpPage() {
  const nav = useNavigate();
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [hash]);

  return (
    <main className="terms-page help-page">
      <header>
        <button type="button" className="icon-btn" aria-label="返回" onClick={() => (window.history.state?.idx > 0 ? nav(-1) : nav('/'))}>
          <ArrowLeft size={20} />
        </button>
        <h1>帮助</h1>
      </header>

      <div className="terms">
        <p className="terms-lead">校墙几个不太一眼看懂的功能，在这里简单说明。</p>
        <nav className="help-toc" aria-label="目录">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }}>
              {label}
            </a>
          ))}
        </nav>

        <section id="levels">
          <h2>等级和经验</h2>
          <p>每个吧单独计算等级。加入一个吧以后，在这个吧里签到、发帖、被人点赞都会涨经验，经验够了就升级，名字旁边会挂上这个吧的牌子。等级目前只是荣誉，不影响任何权限。</p>

          <h3>怎么涨经验</h3>
          <div className="help-table" role="table" aria-label="经验来源">
            <div role="row"><span role="cell">每日签到</span><b role="cell">+6</b><small role="cell">每个吧每天一次。连签每满 7 天多 1 点，最多 +10；断签一天重新算</small></div>
            <div role="row"><span role="cell">发主题帖</span><b role="cell">+4</b><small role="cell">每个吧每天最多从发帖、回复拿 40 点</small></div>
            <div role="row"><span role="cell">回复</span><b role="cell">+2</b><small role="cell">少于 5 个字又没带图的回复不算</small></div>
            <div role="row"><span role="cell">被点赞或回应</span><b role="cell">+1</b><small role="cell">同一个人一天只算一次，每天最多 10 点，自己赞自己不算</small></div>
          </div>
          <ul>
            <li>帖子通过审核以后才加经验。被吧务或管理员当作违规删掉，会扣回这条帖子给的经验；自己删帖不扣。</li>
            <li>退出吧不会清空经验，只是不再显示牌子，重新加入就回来了。</li>
            <li>吧列表顶部的「一键签到」可以一次签完所有加入了的吧。</li>
          </ul>

          <h3>等级表</h3>
          <p>牌子按等级分四种颜色：1–3 级绿牌，4–9 级蓝牌，10–15 级黄牌，16–18 级橙牌。下面是默认头衔，吧主可以给自己的吧改头衔。</p>
          <div className="help-levels">
            {LEVEL_EXP.map((exp, i) => (
              <div key={i} className="help-level">
                <LevelBadge level={i + 1} title={TITLES[i]} />
                <span className="faint">{exp ? `${exp.toLocaleString()} 经验` : '加入即得'}</span>
              </div>
            ))}
          </div>
          <p className="faint small">每天签到加上正常发帖，大概半年到一学年能拿到黄牌。</p>
        </section>

        <section id="emoji">
          <h2>自定义表情</h2>
          <ul>
            <li>在发帖框或私信里点表情按钮，进入「我的」就能上传自己的表情。支持 JPG、PNG、WebP 和 GIF 动图。</li>
            <li>服务器会把表情压缩成边长不超过 160 像素的小图，动图保留动画。每人最多存 60 个；动图最多 150 帧，压缩后不能超过 600 KB。</li>
            <li>表情和帖子图片一样用随机链接访问，并且同样适用社区规则。从「我的」里删掉表情，不会影响已经发出去的帖子和私信。</li>
          </ul>
        </section>

        <section id="block">
          <h2>拉黑</h2>
          <p>在对方的主页或帖子右上角的 ⋯ 里可以拉黑。拉黑以后：</p>
          <ul>
            <li>你们会互相取消关注。对方不能回复、点赞、转发或引用你的帖子，也不能关注你、给你发私信。</li>
            <li>你在首页、吧、话题和搜索里不会再看到对方的帖子；楼层里对方的回复会折叠起来，想看时可以点开。</li>
            <li>对方的点赞、回复、@ 不会再给你发通知。</li>
            <li>对方不会收到通知，但尝试和你互动时会被拒绝。</li>
          </ul>
          <p>在「设置 → 拉黑名单」里可以查看和解除拉黑。</p>
        </section>

        <section id="report">
          <h2>举报</h2>
          <ul>
            <li>帖子和回复右上角的 ⋯ 里有「举报帖子」，用户主页的 ⋯ 里有「举报用户」。选择原因，需要的话写几句补充说明。</li>
            <li>举报是匿名的，被举报的人不会知道是谁举报的。同一个目标在处理前重复举报只算一次。</li>
            <li>站点管理员会查看举报，删除违规内容或驳回举报。处理完成后，你会收到一条通知。</li>
            <li>只是不想看到某个人的话，直接拉黑更快。</li>
          </ul>
        </section>

        <p className="terms-date">
          <Link to="/terms" className="btn btn-outline">用户协议</Link>{' '}
          <Link to="/privacy" className="btn btn-outline">隐私政策</Link>
        </p>
      </div>
    </main>
  );
}
