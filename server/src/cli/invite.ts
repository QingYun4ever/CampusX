// 命令行生成邀请码：npm run invite -- --uses 50 --note "高三(2)班" --days 30
import { parseArgs } from 'node:util';
import { createBootstrapInvite, createInvite, formatInvite } from '../auth.ts';

const { values } = parseArgs({
  options: {
    bootstrap: { type: 'boolean' },
    uses: { type: 'string', default: '1' },
    note: { type: 'string', default: '' },
    days: { type: 'string' },
    count: { type: 'string', default: '1' },
  },
});

if (values.bootstrap) {
  try {
    console.log(createBootstrapInvite());
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
} else {
  for (let i = 0; i < Number(values.count); i++) {
    const code = createInvite({
      maxUses: Number(values.uses),
      note: values.note,
      expiresDays: values.days ? Number(values.days) : null,
    });
    console.log(formatInvite(code));
  }
}
