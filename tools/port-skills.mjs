#!/usr/bin/env node
// Generator: turn skills/ into per-tool rule files for non-Claude AI coding tools.
// Usage: node tools/port-skills.mjs --target <cursor|windsurf|copilot|continue|aider|cline|all> [--out <dir>] [--repo-url <url>]

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

function listSkills() {
  return readdirSync(SKILLS_DIR).filter((name) => {
    try { return statSync(join(SKILLS_DIR, name, 'SKILL.md')).isFile(); } catch { return false; }
  }).sort();
}

function parseSkill(slug) {
  const skillDir = join(SKILLS_DIR, slug);
  const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing frontmatter in skills/${slug}/SKILL.md`);
  const [, fmText, body] = match;

  const frontmatter = {};
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (val.trim() === '>') {
      const parts = [];
      i++;
      while (i < lines.length && /^\s+\S/.test(lines[i])) {
        parts.push(lines[i].trim());
        i++;
      }
      frontmatter[key] = parts.join(' ').replace(/\s+/g, ' ').trim();
      i--;
    } else {
      frontmatter[key] = val.trim();
    }
  }

  const refsDir = join(skillDir, 'references');
  let references = [];
  try {
    references = readdirSync(refsDir).filter((f) => f.endsWith('.md')).sort();
  } catch {}

  return { slug, frontmatter, body, references, refsDir };
}

function ensureDir(path) { mkdirSync(path, { recursive: true }); }

function writeFile(path, content) {
  ensureDir(dirname(path));
  writeFileSync(path, content);
}

function copyReferences(skill, targetDir) {
  for (const ref of skill.references) {
    writeFile(join(targetDir, ref), readFileSync(join(skill.refsDir, ref), 'utf8'));
  }
}

function yamlString(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

function rewriteCrossRefs(body, slugs, linker) {
  const known = new Set(slugs);
  return body.replace(/→ `([a-z][a-z0-9-]+)`/g, (match, slug) => {
    return known.has(slug) ? `→ ${linker(slug)}` : match;
  });
}

function prepForMonolith(body) {
  const noH1 = body.replace(/^\s*#\s[^\n]*\n/, '');
  return noH1.replace(/^(#{1,5}) /gm, (_, hashes) => '#'.repeat(hashes.length + 1) + ' ');
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

function emitCursor(skills, outDir) {
  const slugs = skills.map((s) => s.slug);
  for (const skill of skills) {
    const { slug, frontmatter, body, references } = skill;
    const rewritten = rewriteCrossRefs(body, slugs, (s) => `[${s}](mdc:.cursor/rules/${s}.mdc)`);
    const refBlock = references.length
      ? '\n\n## Bundled reference docs\n\n' +
        references.map((r) => `- [${r.replace(/\.md$/, '')}](../../docs/eclipse-store/${slug}/${r})`).join('\n') + '\n'
      : '';
    const file = [
      '---',
      `description: ${yamlString(frontmatter.description)}`,
      'globs:',
      'alwaysApply: false',
      '---',
      '',
      rewritten.trimStart() + refBlock,
    ].join('\n');
    writeFile(join(outDir, '.cursor', 'rules', `${slug}.mdc`), file);
    copyReferences(skill, join(outDir, 'docs', 'eclipse-store', slug));
  }
}

function emitWindsurf(skills, outDir) {
  const slugs = skills.map((s) => s.slug);
  for (const skill of skills) {
    const { slug, frontmatter, body, references } = skill;
    const rewritten = rewriteCrossRefs(body, slugs, (s) => `[${s}](${s}.md)`);
    const refBlock = references.length
      ? '\n\n## Bundled reference docs\n\n' +
        references.map((r) => `- [${r.replace(/\.md$/, '')}](../../docs/eclipse-store/${slug}/${r})`).join('\n') + '\n'
      : '';
    const file = [
      '---',
      'trigger: model_decision',
      `description: ${yamlString(frontmatter.description)}`,
      '---',
      '',
      rewritten.trimStart() + refBlock,
    ].join('\n');
    writeFile(join(outDir, '.windsurf', 'rules', `${slug}.md`), file);
    copyReferences(skill, join(outDir, 'docs', 'eclipse-store', slug));
  }
}

function emitContinue(skills, outDir) {
  const slugs = skills.map((s) => s.slug);
  for (const skill of skills) {
    const { slug, frontmatter, body, references } = skill;
    const rewritten = rewriteCrossRefs(body, slugs, (s) => `\`${s}\``);
    const refBlock = references.length
      ? '\n\n## Bundled reference docs\n\n' +
        references.map((r) => `- docs/eclipse-store/${slug}/${r}`).join('\n') + '\n'
      : '';
    const file = [
      '---',
      `name: ${slug}`,
      `description: ${yamlString(frontmatter.description)}`,
      'alwaysApply: false',
      '---',
      '',
      rewritten.trimStart() + refBlock,
    ].join('\n');
    writeFile(join(outDir, '.continue', 'rules', `${slug}.md`), file);
    copyReferences(skill, join(outDir, 'docs', 'eclipse-store', slug));
  }
}

function emitCline(skills, outDir) {
  const slugs = skills.map((s) => s.slug);
  for (const skill of skills) {
    const { slug, body, references } = skill;
    const rewritten = rewriteCrossRefs(body, slugs, (s) => `\`${s}\` (see .clinerules/${s}.md)`);
    const refBlock = references.length
      ? '\n\n## Bundled reference docs\n\n' +
        references.map((r) => `- docs/eclipse-store/${slug}/${r}`).join('\n') + '\n'
      : '';
    writeFile(join(outDir, '.clinerules', `${slug}.md`), rewritten.trimStart() + refBlock);
    copyReferences(skill, join(outDir, 'docs', 'eclipse-store', slug));
  }
}

function emitCopilot(skills, outDir, repoUrl) {
  const slugs = skills.map((s) => s.slug);
  const parts = [];
  parts.push('# Eclipse Store — Project Instructions');
  parts.push('');
  parts.push('Guidance for building applications with Eclipse Store and Eclipse Serializer. Each section below is a self-contained topic; apply whichever matches the task at hand.');
  parts.push('');
  parts.push('## Index');
  parts.push('');
  for (const skill of skills) {
    const firstSentence = skill.frontmatter.description.split(/(?<=[.!?])\s/)[0];
    parts.push(`- **${skill.slug}** — ${firstSentence}`);
  }
  parts.push('');
  for (const skill of skills) {
    const { slug, body, references } = skill;
    const rewritten = rewriteCrossRefs(body, slugs, (s) => `the \`${s}\` section below`);
    parts.push(`## Skill: ${slug}`);
    parts.push('');
    parts.push(prepForMonolith(rewritten).trim());
    if (references.length && repoUrl) {
      parts.push('');
      parts.push('**Further reading** (not inlined — see source):');
      for (const ref of references) {
        parts.push(`- [${ref.replace(/\.md$/, '')}](${repoUrl}/blob/main/skills/${slug}/references/${ref})`);
      }
    }
    parts.push('');
  }
  writeFile(join(outDir, '.github', 'copilot-instructions.md'), parts.join('\n'));
}

function emitAider(skills, outDir) {
  const slugs = skills.map((s) => s.slug);
  const parts = [];
  parts.push('# Eclipse Store — Conventions');
  parts.push('');
  parts.push('Topic-focused guidance for Eclipse Store / Eclipse Serializer. Apply the section that matches the task.');
  parts.push('');
  for (const skill of skills) {
    const { slug, body } = skill;
    const rewritten = rewriteCrossRefs(body, slugs, (s) => `the \`${s}\` section below`);
    parts.push(`## ${slug}`);
    parts.push('');
    parts.push(prepForMonolith(rewritten).trim());
    parts.push('');
  }
  writeFile(join(outDir, 'CONVENTIONS.md'), parts.join('\n'));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const TARGETS = {
  cursor: emitCursor,
  windsurf: emitWindsurf,
  copilot: emitCopilot,
  continue: emitContinue,
  aider: emitAider,
  cline: emitCline,
};

function printHelp() {
  process.stderr.write(`
Usage: node tools/port-skills.mjs --target <target> [--out <dir>] [--repo-url <url>]

Targets:
  cursor     .cursor/rules/<slug>.mdc   + docs/eclipse-store/<slug>/*
  windsurf   .windsurf/rules/<slug>.md  + docs/eclipse-store/<slug>/*
  copilot    .github/copilot-instructions.md (single file; refs link to source)
  continue   .continue/rules/<slug>.md  + docs/eclipse-store/<slug>/*
  aider      CONVENTIONS.md (single file, no refs)
  cline      .clinerules/<slug>.md      + docs/eclipse-store/<slug>/*
  all        emits every target under <out>/<target>/

Options:
  --out <dir>          Output root. Default: dist/<target>/ inside the repo.
  --repo-url <url>     Base repo URL for Copilot's reference links.
                       Default: https://github.com/cyrock-ai/eclipse-store-claude
`);
}

function parseArgs(argv) {
  const args = { target: null, out: null, repoUrl: 'https://github.com/cyrock-ai/eclipse-store-claude' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') args.target = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--repo-url') args.repoUrl = argv[++i];
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { process.stderr.write(`Unknown arg: ${a}\n`); printHelp(); process.exit(1); }
  }
  if (!args.target) { printHelp(); process.exit(1); }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const slugs = listSkills();
  const skills = slugs.map(parseSkill);

  const targets = args.target === 'all' ? Object.keys(TARGETS) : [args.target];
  for (const t of targets) {
    if (!TARGETS[t]) {
      process.stderr.write(`Unknown target: ${t}\n`);
      process.exit(1);
    }
    const outDir = args.out
      ? (args.target === 'all' ? join(args.out, t) : args.out)
      : join(REPO_ROOT, 'dist', t);
    if (t === 'copilot') TARGETS[t](skills, outDir, args.repoUrl);
    else TARGETS[t](skills, outDir);
    process.stdout.write(`[${t}] emitted ${skills.length} skills → ${outDir}\n`);
  }
}

main();
