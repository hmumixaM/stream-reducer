import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@cloudflare/containers', () => ({getContainer:vi.fn()}));
vi.mock('../src/pipeline/container', () => ({containerKey:(_env,base)=>base,releaseContainer:vi.fn()}));
import { getContainer } from '@cloudflare/containers';
import { releaseContainer } from '../src/pipeline/container';
import { audioDiagnosticRoutes } from '../src/routes/audioDiagnostic';

const token='test-audio-service-key';
const env={AUDIO_OFFLOAD_TOKEN:token,PIPELINE_CONTAINER:{}};
beforeEach(()=>vi.resetAllMocks());
describe('bounded audio deployment diagnostic',()=>{
  it('rejects missing/wrong credentials before starting a container',async()=>{
    for(const header of ['', 'wrong']) {
      const result=await audioDiagnosticRoutes.request('/audio-check',{method:'POST',headers:{'x-audio-token':header}},env);
      expect(result.status).toBe(401);
    }
    expect(getContainer).not.toHaveBeenCalled();
  });
  it('forwards only the fixed diagnostic path and releases the instance',async()=>{
    const fetch=vi.fn().mockResolvedValue(Response.json({ok:true}));
    getContainer.mockReturnValue({fetch});
    const result=await audioDiagnosticRoutes.request('/audio-check',{method:'POST',headers:{'x-audio-token':token},body:'ignored caller URL'},env);
    expect(await result.json()).toEqual({ok:true});
    expect(fetch.mock.calls[0][0].url).toBe('http://pipeline/audio-check');
    expect(releaseContainer).toHaveBeenCalledWith(env,'audio-check');
  });
});
