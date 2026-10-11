import {describe,expect,it,vi} from 'vitest';
import {HermesPyth,pythUpdateHex} from '../src/price-feed.ts';
describe('Hermes authenticated transport',()=>{
 it('preserves the endpoint prefix and sends credentials only in the authorization header',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({binary:{encoding:'base64',data:[]},parsed:[]}))),key='test-api-key';
  await new HermesPyth('https://pyth.dourolabs.app/hermes',fetcher as typeof fetch,key).getLatestPriceUpdates(['0x1234']);
  const [url,init]=fetcher.mock.calls[0] as unknown as [URL,RequestInit];
  expect(url.pathname).toBe('/hermes/v2/updates/price/latest');expect(url.toString()).not.toContain(key);
  expect(url.searchParams.getAll('ids[]')).toEqual(['0x1234']);expect(init.headers).toEqual({Authorization:`Bearer ${key}`});
 });
 it('redacts fetch errors that could contain authorization or request bodies',async()=>{
  const provider=new HermesPyth(undefined,async()=>{throw new Error('sensitive-provider-error');},'secret');
  await expect(provider.getLatestPriceUpdates([])).rejects.toThrow(/^Hermes request failed$/);
 });
});

it('normalizes Hermes base64 to exactly the Pyth EVM bytes without changing the payload',()=>{
 expect(pythUpdateHex({encoding:'base64',data:['q80=']})).toEqual(['0xabcd']);
 expect(pythUpdateHex({encoding:'hex',data:['abcd','0xABCD']})).toEqual(['0xabcd','0xabcd']);
 expect(()=>pythUpdateHex({encoding:'base64',data:['not-valid!']})).toThrow('invalid Pyth update encoding');
});
