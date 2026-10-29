import { useRef, useState } from 'react';
import { parseBackendModels } from '../../shared/backend-models';
import type { BackendAccountInput } from '../../shared/ipc';
import { call } from '../api';
import { t } from '../i18n';
import { useStore } from '../store';
import { Button, Field, inputClass } from './ui';

export function ServiceAccount() {
  const { toast, backend } = useStore();
  const [name, setName] = useState('');
  const [upstream, setUpstream] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [auth, setAuth] = useState<BackendAccountInput['auth']>('x-api-key');
  const [models, setModels] = useState('');
  const [model, setModel] = useState('');
  const [priority, setPriority] = useState('100');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const revision = useRef(0);
  const changed = () => { revision.current++; setResult(null); };
  const modelMap = parseBackendModels(models);
  const choices = [...new Set(Object.values(modelMap ?? {}))];
  const selected = choices.includes(model) ? model : choices[0] ?? '';
  const valid = !!name.trim() && !!upstream.trim() && apiKey.length >= 8 && !!modelMap && priority.trim() !== '' && Number.isInteger(Number(priority)) && Number(priority) >= -1000 && Number(priority) <= 1000;
  const input = (): BackendAccountInput => ({ name: name.trim(), upstream: upstream.trim().replace(/\/$/, ''), apiKey, auth, modelMap: modelMap!, priority: Number(priority) });
  const test = async () => {
    const current = revision.current;
    setBusy(true); setResult(null);
    try {
      const r = await call('accounts.testBackend', { ...input(), model: selected });
      if (current === revision.current) setResult({ ok: r.ok, text: t(`service.result.${r.code}`, { status: r.status ?? '' }) });
    } catch (err) {
      if (current === revision.current) setResult({ ok: false, text: (err as Error).message });
    } finally { setBusy(false); }
  };
  return (
    <form className="mt-4 space-y-3 border-t border-border pt-4" onChange={changed} onSubmit={e => {
      e.preventDefault();
      if (!valid || busy) return;
      setBusy(true);
      void call('accounts.addBackend', input()).then(job => {
        if (job.state === 'failed') toast(false, job.output.join('\n'));
        else { setApiKey(''); changed(); }
      }).catch((err: Error) => toast(false, err.message)).finally(() => setBusy(false));
    }}>
      <p className="text-[12px] text-muted">{t('service.intro')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('service.name')}><input className={inputClass} value={name} maxLength={200} onChange={e => setName(e.target.value)} placeholder="My Claude API" required /></Field>
        <Field label={t('service.url')}><input className={inputClass} type="url" value={upstream} onChange={e => setUpstream(e.target.value)} placeholder="https://api.example.com/anthropic" required /></Field>
      </div>
      <p className="text-[11px] text-muted">{t('service.urlHint')}</p>
      <div className="grid items-start gap-3 sm:grid-cols-[1fr_200px_140px]">
        <Field label={t('add.key')}><input className={inputClass} type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} required /></Field>
        <Field label={t('service.auth')}><select className={inputClass} value={auth} onChange={e => setAuth(e.target.value as BackendAccountInput['auth'])}><option value="x-api-key">x-api-key</option><option value="bearer">Bearer</option></select></Field>
        <Field label={t('add.priority')}><input className={inputClass} type="number" min={-1000} max={1000} value={priority} onChange={e => setPriority(e.target.value)} required /></Field>
      </div>
      <Field label={t('service.models')} hint={t('service.modelsHint')}>
        <textarea className={`${inputClass} min-h-24 font-mono`} value={models} onChange={e => setModels(e.target.value)} placeholder={'claude-sonnet-4-6\nclaude-opus-4-6 = vendor/claude-opus-4-6'} required />
      </Field>
      {models.trim() && !modelMap && <p className="text-[12px] text-bad">{t('service.modelsInvalid')}</p>}
      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_auto]">
        <Field label={t('service.testModel')}><select className={inputClass} value={selected} onChange={e => setModel(e.target.value)} disabled={!choices.length}>{choices.map(m => <option key={m}>{m}</option>)}</select></Field>
        <Button disabled={!valid || busy} onClick={() => void test()}>{t(busy ? 'service.busy' : 'service.test')}</Button>
        <Button type="submit" variant="primary" disabled={!valid || busy || backend?.status?.readOnly}>{t('service.save')}</Button>
      </div>
      <p className="text-[11px] text-muted">{t('service.testHint')}</p>
      <p className="text-[11px] text-muted">{t('add.keyHint')} {t('add.priorityHint')}</p>
      {result && <p role="status" className={`text-[12px] ${result.ok ? 'text-ok' : 'text-bad'}`}>{result.text}</p>}
    </form>
  );
}
