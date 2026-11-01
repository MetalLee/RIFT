import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { sandboxCommand } from '../../src/agent/filesystem-sandbox.js';
import { execute } from '../../src/git/process.js';

describe.runIf(process.platform === 'darwin')('macOS Seatbelt kernel boundaries', () => {
  it('permits assigned writes and private temp files while denying secrets, symlink escapes, metadata writes and host sockets', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'rift-seatbelt-')));
    const own = path.join(root, 'own'), foreign = path.join(root, 'foreign'), metadata = path.join(own, 'metadata');
    await mkdir(metadata, { recursive: true }); await mkdir(foreign);
    await writeFile(path.join(foreign, 'secret'), 'FOREIGN_SECRET');
    await writeFile(path.join(own, '.env'), 'PROJECT_SECRET');
    await mkdir(path.join(own,'nested'));await writeFile(path.join(own,'nested','.env'),'NESTED_SECRET');
    await writeFile(path.join(metadata, 'value'), 'READ_ONLY');
    await symlink(foreign, path.join(own, 'escape'));
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end('HOST_SECRET'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const code = `const fs=require('fs'),assert=require('assert'),path=require('path');
        assert(!process.env.RIFT_TEST_SECRET);
        for(const p of [${JSON.stringify(path.join(foreign,'secret'))},'.env','escape/secret'])assert.throws(()=>fs.readFileSync(p));
        assert.equal(fs.readFileSync('metadata/value','utf8'),'READ_ONLY');assert.throws(()=>fs.writeFileSync('metadata/value','bad'));
        assert.throws(()=>fs.renameSync('nested','moved'));
        assert.throws(()=>fs.renameSync(process.cwd(),path.join(require('os').tmpdir(),'moved-root')));
        fs.writeFileSync('result','OK');fs.writeFileSync(path.join(require('os').tmpdir(),'marker'),'TEMP');
        const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>process.exit(1));s.on('error',e=>{assert(['EPERM','EACCES'].includes(e.code));console.log('ISOLATED');});`;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
      const argv = await sandboxCommand([own], own, `${quote(process.execPath)} -e ${quote(code)}`, [], { readOnlyRoots: [metadata] });
      const result = await execute(argv[0]!, argv.slice(1), own, { env: { RIFT_TEST_SECRET: 'DO_NOT_INHERIT' }, timeoutMs: 10000 });
      expect(result).toMatchObject({ exitCode: 0, stdout: 'ISOLATED\n' });
      expect(requests).toBe(0); expect(await readFile(path.join(own,'result'),'utf8')).toBe('OK');
      expect(await readFile(path.join(metadata,'value'),'utf8')).toBe('READ_ONLY');
      expect(await readFile(path.join(foreign,'secret'),'utf8')).toBe('FOREIGN_SECRET');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
});
