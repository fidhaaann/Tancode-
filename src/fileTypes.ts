import * as path from 'node:path';

export type FileCategory =
	| 'web'
	| 'config'
	| 'programming'
	| 'infrastructure'
	| 'documentation'
	| 'data'
	| 'other';

export interface FileType {
	id: string;
	languageIds: readonly string[];
	extensions: readonly string[];
	fileNames?: readonly string[];
	category: FileCategory;
}

const type = (id: string, languageIds: string[], extensions: string[], category: FileCategory, fileNames?: string[]): FileType =>
	({ id, languageIds, extensions, category, fileNames });

export const FILE_TYPES: readonly FileType[] = [
	type('html', ['html'], ['.html', '.htm', '.xhtml'], 'web'),
	type('css', ['css', 'scss', 'sass', 'less', 'stylus'], ['.css', '.scss', '.sass', '.less', '.styl'], 'web'),
	type('javascript', ['javascript', 'javascriptreact'], ['.js', '.jsx', '.mjs', '.cjs'], 'web'),
	type('typescript', ['typescript', 'typescriptreact'], ['.ts', '.tsx', '.mts', '.cts'], 'web'),
	type('template', ['vue', 'svelte', 'astro', 'handlebars', 'hbs', 'ejs', 'pug', 'njk'], ['.vue', '.svelte', '.astro', '.hbs', '.handlebars', '.ejs', '.pug', '.njk'], 'web'),
	type('graphql', ['graphql'], ['.graphql', '.gql'], 'web'),
	type('wat', ['wat'], ['.wat'], 'web'),
	type('json', ['json', 'jsonc', 'json5'], ['.json', '.jsonc', '.json5'], 'config'),
	type('yaml', ['yaml'], ['.yaml', '.yml'], 'config'),
	type('toml', ['toml'], ['.toml'], 'config'),
	type('xml', ['xml'], ['.xml', '.xsd', '.xsl', '.xslt', '.svg'], 'config'),
	type('ini', ['ini', 'properties'], ['.ini', '.cfg', '.conf', '.properties'], 'config'),
	type('python', ['python'], ['.py', '.pyi', '.pyw'], 'programming'),
	type('java', ['java'], ['.java'], 'programming'),
	type('kotlin', ['kotlin'], ['.kt', '.kts'], 'programming'),
	type('c', ['c'], ['.c', '.h'], 'programming'),
	type('cpp', ['cpp'], ['.cc', '.cpp', '.cxx', '.hpp', '.hh'], 'programming'),
	type('csharp', ['csharp'], ['.cs'], 'programming'),
	type('go', ['go'], ['.go'], 'programming'),
	type('rust', ['rust'], ['.rs'], 'programming'),
	type('ruby', ['ruby'], ['.rb', '.rake'], 'programming'),
	type('php', ['php'], ['.php'], 'programming'),
	type('swift', ['swift'], ['.swift'], 'programming'),
	type('dart', ['dart'], ['.dart'], 'programming'),
	type('r', ['r'], ['.r'], 'programming'),
	type('scala', ['scala'], ['.scala'], 'programming'),
	type('groovy', ['groovy'], ['.groovy'], 'programming'),
	type('elixir', ['elixir'], ['.ex', '.exs'], 'programming'),
	type('erlang', ['erlang'], ['.erl', '.hrl'], 'programming'),
	type('clojure', ['clojure'], ['.clj', '.cljs', '.cljc', '.edn'], 'programming'),
	type('haskell', ['haskell'], ['.hs'], 'programming'),
	type('ocaml', ['ocaml'], ['.ml', '.mli'], 'programming'),
	type('lua', ['lua'], ['.lua'], 'programming'),
	type('perl', ['perl'], ['.pl', '.pm'], 'programming'),
	type('shell', ['shellscript', 'bat', 'powershell'], ['.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd'], 'programming'),
	type('sql', ['sql'], ['.sql'], 'programming'),
	type('assembly', ['asm'], ['.asm', '.s', '.S'], 'programming'),
	type('solidity', ['solidity'], ['.sol'], 'programming'),
	type('markdown', ['markdown', 'mdx'], ['.md', '.mdx', '.markdown'], 'documentation'),
	type('rst', ['restructuredtext'], ['.rst'], 'documentation'),
	type('text', ['plaintext'], ['.txt'], 'documentation'),
	type('asciidoc', ['asciidoc'], ['.adoc', '.asciidoc'], 'documentation'),
	type('mermaid', ['mermaid'], ['.mmd', '.mermaid'], 'documentation'),
	type('csv', ['csv'], ['.csv', '.tsv'], 'data'),
	type('protobuf', ['proto3'], ['.proto'], 'data'),
	type('jupyter', ['jupyter'], ['.ipynb'], 'data'),
	type('terraform', ['terraform'], ['.tf', '.tfvars'], 'infrastructure'),
	type('hcl', ['hcl'], ['.hcl'], 'infrastructure'),
	type('docker', ['dockerfile'], [], 'infrastructure', ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']),
	type('build', ['makefile', 'cmake', 'groovy'], [], 'infrastructure', ['Makefile', 'GNUmakefile', 'CMakeLists.txt', 'Jenkinsfile', 'Procfile', 'Justfile', 'BUILD', 'WORKSPACE', 'pom.xml', 'build.gradle', 'build.gradle.kts']),
	type('config-dotfile', ['ini', 'yaml', 'json'], [], 'config', ['.editorconfig', '.browserslistrc', '.npmrc', '.nvmrc', '.prettierrc', '.eslintrc', '.env', '.env.example', '.env.development', '.env.production', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'Cargo.lock', 'composer.lock']),
];

const byExtension = new Map<string, FileType>();
const byName = new Map<string, FileType>();
for (const fileType of FILE_TYPES) {
	for (const extension of fileType.extensions) byExtension.set(extension.toLowerCase(), fileType);
	for (const name of fileType.fileNames ?? []) byName.set(name.toLowerCase(), fileType);
}

export function fileTypeFor(fileName: string, languageId?: string): FileType | undefined {
	const base = path.basename(fileName);
	const byFileName = byName.get(base.toLowerCase());
	if (byFileName) return byFileName;
	const byLanguage = languageId ? FILE_TYPES.find(t => t.languageIds.includes(languageId)) : undefined;
	return byLanguage ?? byExtension.get(path.extname(base).toLowerCase());
}

export function languageIdFor(fileName: string, languageId?: string): string | undefined {
	if (languageId && FILE_TYPES.some(t => t.languageIds.includes(languageId))) return languageId;
	return fileTypeFor(fileName)?.languageIds[0];
}

export function isSupportedFile(fileName: string, languageId?: string): boolean {
	return fileTypeFor(fileName, languageId) !== undefined;
}

export function allSupportedExtensions(): readonly string[] {
	return [...byExtension.keys()];
}
