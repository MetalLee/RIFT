import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, lstatSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { invariant } from '../contracts/index.js';
import type { SkillService, CompiledSkills } from './service.js';

export function workspaceSkillRoot(home:string,workspaceId:string){
  invariant(/^[a-zA-Z0-9_-]+$/.test(workspaceId),'WORKSPACE_MISMATCH','Invalid workspace resource identity.');
  return path.resolve(home,'workspaces',workspaceId,'skill-resources');
}
/** Publish immutable version bytes, never links to the original installation.
 * The executor mounts this workspace-only tree read-only, including for scripts. */
export function installedSkills(service:SkillService,home:string,workspaceId:string,agentId:string,runtime:string):CompiledSkills {
  const verified=['codex','dsh'].includes(runtime);
  const compiled=service.resolveEffective(workspaceId,agentId,{runtime,resources:verified,scripts:verified});
  if(!compiled.resources.length)return compiled;
  const root=workspaceSkillRoot(home,workspaceId);mkdirSync(root,{recursive:true,mode:0o700});
  invariant(realpathSync(root)===root,'SKILL_PATH_ESCAPE','Skill runtime storage must be a canonical directory.');
  const locations:string[]=[];
  for(const version of compiled.versions){
    const resources=compiled.resources.filter(r=>r.versionId===version.versionId);if(!resources.length)continue;
    invariant(/^[a-zA-Z0-9_-]+$/.test(version.versionId),'SKILL_PATH_ESCAPE','Invalid Skill version identity.');
    const directory=path.join(root,version.versionId);
    const source=service.version(workspaceId,version.versionId);
    const entries=[{path:'SKILL.md',bytes:Buffer.from(source.instructions)},...resources.map(r=>({path:r.path,bytes:Buffer.from(r.contentBase64,'base64')}))];
    for(const item of entries)invariant(item.path!==''&&!path.isAbsolute(item.path)&&!item.path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'),'SKILL_PATH_ESCAPE','Invalid Skill resource path.');
    try{
      const info=lstatSync(directory);invariant(info.isDirectory()&&!info.isSymbolicLink(),'SKILL_PATH_ESCAPE','Skill snapshot changed.');
      for(const item of entries){const file=path.join(directory,item.path);invariant(realpathSync(file)===file&&lstatSync(file).isFile()&&readFileSync(file).equals(item.bytes),'SKILL_PATH_CHANGED','Skill snapshot bytes changed.');}
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      // Existing incomplete snapshots fail rather than changing execution bytes.
      try{lstatSync(directory);throw new Error('Incomplete Skill snapshot');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const temporary=mkdtempSync(path.join(root,'.publish-'));
      try{for(const item of entries){const file=path.join(temporary,item.path);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});writeFileSync(file,item.bytes,{flag:'wx',mode:0o500});}renameSync(temporary,directory);}finally{rmSync(temporary,{recursive:true,force:true});}
    }
    locations.push(`Skill ${version.name} immutable resource directory: ${directory}. Use this directory for relative resource/script paths in its instructions (including paths under .agents/skills or .codex/skills). Keep generated output in the current workspace checkout. Do not edit the snapshot. In formal read-only review/analysis, use rift_skill_resource with this versionId and relative resource path to inspect data/scripts; this Skill does not enable script execution in read-only modes.`);
  }
  return {...compiled,instructions:compiled.instructions+'\n\n'+locations.join('\n')};
}
