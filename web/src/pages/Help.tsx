/**
 * 帮助：等级和经验、签到、AI 助手、表情、拉黑、举报。不用登录也能看（和隐私政策一样）。
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
  ['feed', '首页怎么排'],
  ['levels', '等级和经验'],
  ['crystals', '紫水晶'],
  ['ai', 'AI 助手'],
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

        <section id="feed">
          <h2>首页怎么排</h2>
          <ul>
            <li><b>推荐</b>：最近 30 天的帖子按热度排。赞、回应、回复的人数、转发、引用、打赏都会让一条帖子更热，但热度会随时间变淡，所以刚发的帖子没人互动也会排在前面几个小时。你关注的人和你加入的吧的帖子会靠前一些；你已经看过、赞过的会往后放，刷新时先看到没看过的。推荐的翻完了，会接着按时间往前翻。</li>
            <li><b>最新</b>：全站的帖子按发帖时间排，最新的在最上面。</li>
            <li><b>关注</b>：你自己、你关注的人、你加入的吧里的帖子，按时间排。</li>
            <li>同一个人连着发的几条会被别人的帖子隔开。标着「推流」的是有人用紫水晶推的，每页最多一条，同一条只给你看一次。</li>
          </ul>
        </section>

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

        <section id="crystals">
          <h2>紫水晶</h2>
          <p>紫水晶是全站通用的点数，和每个吧的经验分开算：经验只涨不花，紫水晶可以花。在头像菜单里点「紫水晶」能看到余额、新手任务和明细。</p>
          <h3>怎么获得</h3>
          <div className="help-table" role="table" aria-label="紫水晶来源">
            <div role="row"><span role="cell">每日签到</span><b role="cell">+5</b><small role="cell">每天一次，在紫水晶页面或任意一个吧签到都算。连签每满 7 天多 1 颗，最多 +8</small></div>
            <div role="row"><span role="cell">被点赞或回应</span><b role="cell">+1</b><small role="cell">同一个人一天只算一次，每天最多 20 颗。注册不满 3 天的账号点的赞不算</small></div>
            <div role="row"><span role="cell">新手任务</span><b role="cell">+10~20</b><small role="cell">换头像、写简介、发第一条帖子等，每项领一次</small></div>
            <div role="row"><span role="cell">收到打赏</span><b role="cell">不定</b><small role="cell">别人觉得你的帖子好，可以送你紫水晶</small></div>
            <div role="row"><span role="cell">参加活动</span><b role="cell">看活动</b><small role="cell">活动期间带指定话题发一条帖子，管理员审核通过后发放，每个活动每人一次；有的活动签到还翻倍</small></div>
          </div>
          <h3>怎么用</h3>
          <ul>
            <li><b>解锁头像装扮</b>：商场里的光环和头像框用紫水晶解锁，解锁后随时换着戴。改版前已经戴着的那一个直接算解锁。动画在个人主页和商场的大头像上播放，时间线里不动。</li>
            <li><b>邀请同学</b>：注册满 3 天后，在「紫水晶 → 邀请同学」生成自己的邀请码。同学用它注册、签到满 3 天，你得 20 颗，最多算 10 个人；和你在同一个网络注册的不算。一个邀请码最多邀请 30 人。</li>
            <li><b>打赏</b>：帖子右上角「…」里选「打赏紫水晶」，直接转给作者。每天最多送 100 颗，注册满 3 天才能打赏，送出后不能撤回。</li>
            <li><b>推流</b>：帖子右上角「…」里选「推流」，1 颗紫水晶让 2 个人在首页看到这条帖子，标着「推流」，档位 10、25、50 颗。自己的帖子和别人的好帖子都能推，只能推 7 天内发的公开主帖。只推给最近两周上过线、还没看过这条的同学，每人一次，所以最多能买多少人，弹窗里会写。72 小时内没推完的，按没看到的人数退回紫水晶。每天最多花 100 颗。</li>
          </ul>
          <h3>活动</h3>
          <p>管理员会办一些活动，比如校运会、迎新。活动开始时 App 会推送，首页顶部会显示活动卡片，紫水晶页面也能看到。活动期间带上活动的话题（比如 #校运会）发一条公开的主帖就算参加。管理员看过你的帖子、审核通过后，才会发活动设好的紫水晶，每个活动每人一次，结果会通知你。没通过的话通知里会写理由，你可以再发一条重新参加。拿到奖励后帖子因为违规被删，奖励会扣回，也不能再领。</p>
          <ul>
            <li>帖子因为违规被删除，它被赞和参加活动得到的紫水晶会扣回（不会扣成负数）。</li>
            <li>每一笔进出都有记录，可以在明细里查。</li>
          </ul>
        </section>

        <section id="ai">
          <h2>AI 助手</h2>
          <p>站点开启了 AI 助手的话，在帖子或回复里 @ 它（名字旁边有「AI」标签），它会在下面回你一条简短的回复。直接回复它的帖子，也算在继续问它。</p>
          <ul>
            <li>它能看到这串对话从主帖到你这条的内容和里面的图片（最多 6 张，你这条的优先）；看不到你的私信和别的帖子。</li>
            <li>回复都很短，一般一两句话。作业题它只给思路，不直接给答案。</li>
            <li>每人每天能问的次数有上限，用完了它会告诉你。</li>
            <li>它的回答可能出错，学校的具体安排以老师和官方通知为准。觉得回复有问题，可以像普通帖子一样举报。</li>
            <li>不想看到它，可以直接拉黑，它就不会再回你了。</li>
          </ul>
        </section>

        <section id="emoji">
          <h2>自定义表情</h2>
          <ul>
            <li>在发帖框或私信里点表情按钮，进入「我的」就能上传自己的表情。支持 JPG、PNG、WebP 和 GIF 动图。</li>
            <li>服务器会把表情压缩成边长不超过 160 像素的小图，动图保留动画。每人最多存 60 个；动图最多 150 帧，压缩后不能超过 600 KB。</li>
            <li>表情和帖子图片一样用随机链接访问，并且同样适用社区规则。从「我的」里删掉表情，不会影响已经发出去的帖子和私信。</li>
            <li>看到别人发的表情喜欢，长按它（电脑上右键）就能加到自己的表情里。</li>
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
