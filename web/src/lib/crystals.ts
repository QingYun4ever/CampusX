import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Wallet } from './api';

/** 紫水晶钱包（余额、签到、任务、已解锁的装扮） */
export function useWallet(enabled = true) {
  return useQuery({ queryKey: ['wallet'], queryFn: () => api<Wallet>('/me/crystals'), enabled, staleTime: 30_000 });
}

/** 接口返回了新的钱包：直接写进缓存，明细重新取 */
export function useSetWallet() {
  const qc = useQueryClient();
  return (w: Wallet) => {
    qc.setQueryData(['wallet'], w);
    void qc.invalidateQueries({ queryKey: ['crystal-log'] });
  };
}
