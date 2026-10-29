import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyIde, BACKUP_SUFFIX, editSettings, listIdeTargets, parseJsonc, removeTopLevel, setTopLevel, type IdeFiles,
} from '../src/services/ide-connect';

const URL = 'http://localhost:3456';
const KEY = 'claudeCode.environmentVariables';

function memoryFiles(initial: Record<string, string> = {}, dirs: string[] = []): IdeFiles & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    read: path => files[path] ?? null,
    write: (path, data) => { files[path] = data; },
    exists: path => path in files || dirs.includes(path),
    copy: (from, to) => { files[to] = files[from] as string; },
  };
}

describe('JSONC editing', () => {
  const vscode = `{
  // my font
  "editor.fontSize": 14, /* keep */
  "url": "http://x//y", // a string with slashes
  "files.exclude": { "**/.git": true, },
}
`;

  it('parses comments and trailing commas', () => {
    expect(parseJsonc(vscode)).toEqual({ 'editor.fontSize': 14, url: 'http://x//y', 'files.exclude': { '**/.git': true } });
  });

  it('inserts a key without disturbing comments', () => {
    const next = setTopLevel(vscode, KEY, [{ name: 'ANTHROPIC_BASE_URL', value: URL }]);
    expect(next).toContain('// my font');
    expect(next).toContain('/* keep */');
    expect(parseJsonc(next)[KEY]).toEqual([{ name: 'ANTHROPIC_BASE_URL', value: URL }]);
    expect(parseJsonc(next)['editor.fontSize']).toBe(14);
  });

  it('replaces an existing value and removes it again', () => {
    const withKey = setTopLevel(vscode, KEY, [{ name: 'A', value: '1' }]);
    const replaced = setTopLevel(withKey, KEY, [{ name: 'B', value: '2' }]);
    expect(parseJsonc(replaced)[KEY]).toEqual([{ name: 'B', value: '2' }]);
    const removed = removeTopLevel(replaced, KEY);
    expect(parseJsonc(removed)).toEqual(parseJsonc(vscode));
    expect(removed).toContain('// my font');
  });

  it('handles an empty file and an empty object', () => {
    expect(parseJsonc(setTopLevel('', KEY, []))).toEqual({ [KEY]: [] });
    expect(parseJsonc(setTopLevel('{}', KEY, []))).toEqual({ [KEY]: [] });
    expect(parseJsonc(removeTopLevel(setTopLevel('{}', KEY, []), KEY))).toEqual({});
  });

  it('ignores the key name when it appears as a value or nested', () => {
    const text = `{ "a": "${KEY}", "b": { "${KEY}": 1 } }`;
    expect(parseJsonc(setTopLevel(text, KEY, 2))).toEqual({ a: KEY, b: { [KEY]: 1 }, [KEY]: 2 });
  });
});

describe('editSettings', () => {
  it('keeps other extension variables when connecting and disconnecting', () => {
    const start = `{ "${KEY}": [{ "name": "OTHER", "value": "x" }, { "name": "ANTHROPIC_BASE_URL", "value": "http://old" }] }`;
    const on = editSettings('vscode', start, URL);
    expect(parseJsonc(on)[KEY]).toEqual([{ name: 'OTHER', value: 'x' }, { name: 'ANTHROPIC_BASE_URL', value: URL }]);
    expect(parseJsonc(editSettings('vscode', on, null))[KEY]).toEqual([{ name: 'OTHER', value: 'x' }]);
  });

  it('edits only env.ANTHROPIC_BASE_URL in Claude settings', () => {
    const start = JSON.stringify({ model: 'opus', env: { FOO: '1' } });
    const on = JSON.parse(editSettings('claude', start, URL));
    expect(on).toEqual({ model: 'opus', env: { FOO: '1', ANTHROPIC_BASE_URL: URL } });
    expect(JSON.parse(editSettings('claude', JSON.stringify(on), null))).toEqual({ model: 'opus', env: { FOO: '1' } });
    expect(JSON.parse(editSettings('claude', JSON.stringify({ env: { ANTHROPIC_BASE_URL: URL } }), null))).toEqual({});
  });

  it('refuses a file it cannot parse', () => {
    expect(() => editSettings('vscode', '{ "a": ', URL)).toThrow();
  });
});

describe('targets', () => {
  const env = { platform: 'linux' as const, env: {}, home: '/home/u' };
  const codeSettings = join('/home/u/.config', 'Code', 'User', 'settings.json');
  const claudeSettings = join('/home/u/.claude', 'settings.json');

  it('lists installed editors with their connection state', () => {
    const files = memoryFiles({ [codeSettings]: `{ "${KEY}": [{ "name": "ANTHROPIC_BASE_URL", "value": "http://127.0.0.1:3456/" }] }` }, [join('/home/u/.config', 'Code')]);
    const targets = listIdeTargets(3456, { env, files });
    expect(targets.find(t => t.id === 'vscode')).toMatchObject({ installed: true, status: 'connected' });
    expect(targets.find(t => t.id === 'cursor')).toMatchObject({ installed: false, status: 'not-connected' });
    expect(targets.find(t => t.id === 'claude')).toMatchObject({ installed: false });
    expect(listIdeTargets(9999, { env, files }).find(t => t.id === 'vscode')?.status).toBe('other');
  });

  it('marks an unparsable file as unreadable', () => {
    const files = memoryFiles({ [claudeSettings]: '{ broken' });
    expect(listIdeTargets(3456, { env, files, claudeFound: true }).find(t => t.id === 'claude')).toMatchObject({ installed: true, status: 'unreadable' });
  });

  it('backs up the file once before the first change', () => {
    const original = '{ "editor.fontSize": 14 }';
    const files = memoryFiles({ [codeSettings]: original }, [join('/home/u/.config', 'Code')]);
    const target = listIdeTargets(3456, { env, files }).find(t => t.id === 'vscode')!;
    applyIde(target, URL, files);
    expect(files.files[codeSettings + BACKUP_SUFFIX]).toBe(original);
    applyIde(target, null, files);
    expect(files.files[codeSettings + BACKUP_SUFFIX]).toBe(original);
    expect(parseJsonc(files.files[codeSettings]!)).toEqual({ 'editor.fontSize': 14 });
  });

  it('creates a missing settings file without a backup', () => {
    const files = memoryFiles({}, [join('/home/u/.config', 'Code')]);
    const target = listIdeTargets(3456, { env, files }).find(t => t.id === 'vscode')!;
    applyIde(target, URL, files);
    expect(parseJsonc(files.files[codeSettings]!)[KEY]).toEqual([{ name: 'ANTHROPIC_BASE_URL', value: URL }]);
    expect(files.files[codeSettings + BACKUP_SUFFIX]).toBeUndefined();
  });
});
