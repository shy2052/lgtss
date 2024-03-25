const fs = require('fs');
const process = require('process');
const path = require('path');
const execSync = require('child_process').execSync;

const replaceVar = true; // 替换脚本中的变量为默认文本，避免主角名字变量把一句话分割成多句
const SakuraLLaMA = 'http://127.0.0.1:8080/completion';

const HANZI = fs.readFileSync('data/hanzi.txt', 'utf-8').split('');
const KANJI = fs.readFileSync('data/kanji.txt', 'utf-8').split('');

const gameExePath = process.argv.slice(2)[0];
const gamePath = gameExePath ? path.dirname(gameExePath) : null;
if (!gamePath || !fs.existsSync(path.join(gamePath, 'live.dll'))) {
	console.log('使用方法：node lgtss.js <path of GAME.exe>');
	process.exit(1);
}
const gameExeName = path.basename(gameExePath);
if (!fs.existsSync(path.join(gamePath, 'game_files', 'lgtss-lns'))) {
	console.log('解包游戏文件……');
	try {
		process.chdir(gamePath);
		execSync(`start lmar x --verbose --image-format png --output-dir game_files ${gameExeName}`);
		execSync(`start lmlsb extract --output-dir .\\game_files\\lgtss-lns .\\game_files\\0*.lsb`); // 假定脚本文件都在0*.lsb
		if (replaceVar) {
			execSync(`start lmlsb dump --output-file .\\game_files\\lgtss-lns\\変数初期化.lsb.lsc .\\game_files\\変数初期化.lsb`);
		}
		console.log('解包完成');
	} catch (e) {
		console.error('解包失败，请确保已安装Python和pylivemaker。');
		console.error(e);
		process.exit(1);
	}
}
fs.mkdirSync(path.join(gamePath, 'game_files', 'lgtss-translated'), { recursive: true }); // recursive to avoid EEXIST error

let translating = {};
let tempCacheFile = path.join(gamePath, 'game_files', 'lgtss-translating.json');
if (fs.existsSync(tempCacheFile)) {
	translating = JSON.parse(fs.readFileSync(tempCacheFile, 'utf-8'));
	console.log('加载了翻译缓存');
}
function saveCache() {
	fs.writeFileSync(tempCacheFile, JSON.stringify(translating, null, 2));
}

const lnsContent = {};

async function parseLns() {
	let lines = [];
	let vars = {};

	if (replaceVar) {
		let varsraw = fs.readFileSync(path.join(gamePath, 'game_files', 'lgtss-lns', '変数初期化.lsb.lsc'), 'utf-8');
		let res1 = varsraw.matchAll(/VarNew ([^ ]+) ParamType.Str "([^"]+)"/g);
		for (let res2 of res1) {
			vars[res2[1]] = res2[2];
		}
	}

	let files = fs.readdirSync(path.join(gamePath, 'game_files', 'lgtss-lns'));
	for (let file of files) {
		if (file.endsWith('.lsbref')) {
			fs.copyFileSync(path.join(gamePath, 'game_files', 'lgtss-lns', file), path.join(gamePath, 'game_files', 'lgtss-translated', file));
			continue;
		}
		if (!file.endsWith('.lns'))
			continue;
		let text = fs.readFileSync(path.join(gamePath, 'game_files', 'lgtss-lns', file), 'utf-8');
		for (let v in vars) {
			text = text.replace(new RegExp('<VAR NAME="' + v + '"[^>]*>', 'g'), vars[v]);
		}
		text = text.replace(/<\/A><\/STYLE><STYLE ID="\d+" RUBY="[^<>]+"><A ID="\d+">([^<>]+)<\/A><\/STYLE><STYLE ID="\d+"><A ID="\d+">/g, '$1');
		text = text.replace(/<\/STYLE><STYLE ID="\d+" RUBY="[^<>]+">([^<>]+)<\/STYLE><STYLE ID="\d+">/g, '$1');
		lnsContent[file] = text;
		let res = text.matchAll(/[\}>]([^\{\}<>(: TextIns)]*[^\s][^\{\}<>(: TextIns)]*)[<\{]/gm);
		//console.log(res);
		lines = lines.concat(Array.from(res, m => m[1].trim())); // 每项都是单行
		console.log('处理了', file);
	}

	lines.forEach((line, i) => {
		if (!(line in translating)) {
			translating[line] = null;
		}
	});

	saveCache();
}

async function translate(src, tryFixDegradation = false) {
	if (['', '　', '「', '」', '【', '】'].includes(src.trim()))
		return src;

	src = src.replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)); // 全角数字转半角

	let prompt = `<|im_start|>system
你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。<|im_end|>
<|im_start|>user
将下面的日文文本翻译成中文：${src}<|im_end|>
<|im_start|>assistant
`;
	let payload = {
		prompt: prompt,
		n_predict: 1000,
		temperature: 0.1,
		top_p: 0.3,
		top_k: 40,
		repeat_penalty: 1,
		frequency_penalty: tryFixDegradation ? 0.2 : 0,
	};

	let response = await fetch(SakuraLLaMA, {
		headers: {
			'accept': 'application/json',
			'content-type': 'application/json'
		},
		body: JSON.stringify(payload),
		method: 'POST'
	});
	let res = await response.json();

	if (res.stopped_limit) {
		console.log('SakuraLLaMA出现降级，重试');
		return await translate(src, true);
	}

	let txt = res.content.replaceAll('<|im_end|>', '');
	txt = txt.replaceAll('·', '・');
	txt = txt.replaceAll('•', '・');
	txt = txt.replaceAll('—', '─');
	txt = txt.replaceAll('“', '「');
	txt = txt.replaceAll('”', '」');
	txt = txt.replaceAll('\\n', '\n'); // Sakura有时会出现\n，需要转义

	return txt;
}

async function translateLines() {
	let text;
	let maxLength = 500;
	let retryCount = 0;
	while (text = getSegmentedLines(maxLength)) { // 一次翻译多句，文本长度不能超过500
		let lines1 = text.split('\n');
		console.log('正在翻译', lines1.length, '行文本');
		console.log(lines1);
		let res = await translate(text);
		let lines2 = res.split(/\r?\n/);
		if (lines1.length !== lines2.length) { // 行数翻译后不一致一般是因为原文有多个折行，尝试减少文本长度
			retryCount++;
			if (retryCount > 3) {
				maxLength -= 100; // 变为0时是单行
			}
			console.warn('翻译后的行数不一致，重试');
			console.log(lines2);
		} else {
			for (let i = 0; i < lines1.length; i++) {
				translating[lines1[i]] = lines2[i];
			}
			retryCount = 0;
			maxLength = 500;
			console.log('翻译了');
			console.log(res);
			saveCache();
		}
	}

	for (let line in translating) { // 实际上跑不到这里
		if (translating[line] === null) {
			let res = await translate(line);
			translating[line] = res;
			console.log('翻译了', line, res);
		}
	}
}

function getSegmentedLines(maxLength) {
	let lines = [];
	for (let line in translating) {
		if (translating[line] === null) {
			lines.push(line);
		}
		if (lines.join('\n').length > maxLength) {
			if (lines.length > 1) {
				lines.pop();
			}
			break;
		}
	}
	if (lines.length <= 1) {
		return lines.join('\n');
	}
	if (isBadlyFormatedScenario(lines)) { // 文本可能存在被折断的行，去除最后的不完整行
		for (let i = lines.length - 1; i >= 0; i--) {
			if (isNotCorrectLineEnding(lines[i])) {
				lines.pop();
			} else {
				break;
			}
		}
	}

	return lines.join('\n');
}

function isNotCorrectLineEnding(line) {
	return line.match(/[。\.！\!？\?」』】》）\)\]\'\"〟・…～~〜♪♡♥️🤍■]$/) === null;
}

function isBadlyFormatedScenario(lines) {
	return lines.filter(line => line.length <= 100).length >= lines.length / 2
		&& lines.filter(isNotCorrectLineEnding).length <= lines.length / 2
}

async function replaceLns() {
	for (let line in translating) {
		let txt = translating[line];
		for (var j = 0; j < HANZI.length; j++) {
			txt = txt.replace(new RegExp(HANZI[j], 'g'), KANJI[j]);
		}
		translating[line] = txt;
	}
	for (let file in lnsContent) {
		let lnstext = lnsContent[file];
		for (let line in translating) {
			let txt = translating[line];
			lnstext = lnstext.replace(new RegExp('([\}>][\s\r\n　]*)' + line + '([\s\r\n　]*[<\{])', 'gm'), '$1' + txt + '$2');
		}
		fs.writeFileSync(path.join(gamePath, 'game_files', 'lgtss-translated', file), lnstext, 'utf-8');
		console.log('写入了', file);
	}

	let lsbFiles = fs.readdirSync(path.join(gamePath, 'game_files')).filter(file => file.match(/^0.+\.lsb$/));
	process.chdir(gamePath);
	for (let file of lsbFiles) {
		fs.copyFileSync(path.join(gamePath, 'game_files', file), path.join(gamePath, file));
		console.log('正在生成', file);
		let command = `lmlsb batchinsert --no-backup .\\${file} .\\game_files\\lgtss-translated`;
		try {
			let res = execSync(command);
			console.log('生成了', file, res.toString());
		} catch (e) {
			console.error("生成失败，你需要手动运行下面的命令并查看出错的文字");
			console.error(command);
		}
	}
}

(async () => {
	console.log('处理lns……');
	await parseLns();
	console.log('开始翻译……');
	await translateLines();
	console.log('开始生成翻译结果……');
	await replaceLns();
	console.log('汉化完成');
})();
