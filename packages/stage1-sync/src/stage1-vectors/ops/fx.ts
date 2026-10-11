import { direct, type TranslatorTable } from './types.ts';

export const fxOps: TranslatorTable = {
  set_fx_pair: (ctx, c) => direct(async () => {
    await ctx.send(ctx.actors.admin, { kind: 'setFxPair', feedId: c.feedId, inverted: c.inverted, crosscheck: c.crosscheck ? ctx.actors.admin.address : null });
  }),
  fx_snapshot: (ctx, c) => direct(async () => {
    await ctx.submit({ kind: 'snapshotFx', pairId: c.pairId, price: c.price, conf: c.conf, expo: c.expo, publishTime: c.publishTime, crosscheckPrice: c.crosscheckPrice, crosscheckExpo: c.crosscheckExpo }, 'keeper');
  }),
};
