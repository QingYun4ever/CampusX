// 命令行生成邀请码：npm run invite -- --uses 50 --note "高三(2)班" --days 30
import { parseArgs } from 'node:util';
import { createInvite, formatInvite } from '../auth.ts';

const { values } = parseArgs({
  options: {
    uses: { type: 'string', default: '1' },
    note: { type: 'string', default: '' },
    days: { type: 'string' },
    count: { type: 'string', default: '1' },
  },
});

for (let i = 0; i < Number(values.count); i++) {
  const code = createInvite({
    maxUses: Number(values.uses),
    note: values.note,
    expiresDays: values.days ? Number(values.days) : null,
  });
  console.log(formatInvite(code));
}
