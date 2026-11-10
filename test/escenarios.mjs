// Prueba Ronda en un navegador real, sin interfaz y con un perfil temporal, contra
// un servidor local: clics de verdad, y mira las pestañas, su historial y lo que
// le llega al servidor. Sin dependencias.
//
//   npm test                 Brave
//   npm test -- --edge       Edge
//   RONDA_BROWSER=ruta npm test
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const dormir = ms => new Promise(r => setTimeout(r, ms));
const local = process.env.LOCALAPPDATA || '';
const navegador = process.env.RONDA_BROWSER || (process.argv.includes('--edge')
	? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
	: join(local, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'));

if (!existsSync(navegador)) {
	console.error(`No encuentro el navegador: ${navegador}. Indícalo con RONDA_BROWSER.`);
	process.exit(2);
}

// ---- Servidor de pruebas ----------------------------------------------------
let peticiones = [];
const pagina = (titulo, cuerpo, extra = '') => `<!doctype html><meta charset=utf-8><title>${titulo}</title><body ${extra}><h1>${titulo}</h1>${cuerpo}`;
const ENLACES = `
<p><a id=hijo href=/hijo>hijo</a></p>
<p><a id=blanco target=_blank href=/hijo>target blank</a></p>
<p><a id=roto target=_blank href=/no-existe>404</a></p>
<p><a id=adjunto href=/dl/adjunto.zip>adjunto</a></p>
<p><a id=adjuntob target=_blank href=/dl/adjuntob.zip>adjunto blank</a></p>
<p><a id=redir target=_blank href=/redir>redirige a adjunto</a></p>
<p><a id=binario target=_blank href=/binario>octet-stream</a></p>
<p><a id=atributo target=_blank download href=/dl/atributo.zip>atributo download</a></p>
<p><a id=pdf href=/doc.pdf>pdf</a></p>
<form method=post action=/post target=_blank><input type=hidden name=k value=v><button id=post>post</button></form>
<form id=fjs method=post action=/post target=_blank><input type=hidden name=k value=v></form>
<p><button id=postjs onclick="document.getElementById('fjs').submit()">post por script</button></p>
<p><button id=escrita onclick="const w=window.open('');w.document.write('<h1>escrita</h1>');w.document.close()">window.open escrita</button></p>
${[400, 0, 300, 0, 200, 0].map((ms, i) => `<p><a id=r${i + 1} href="/hijo?n=${i + 1}&ms=${ms}">r${i + 1}</a></p>`).join('\n')}`;

const servidor = createServer((req, res) => {
	const u = new URL(req.url, 'http://x');
	const p = u.pathname;

	if (p === '/favicon.ico') {
		res.writeHead(204);
		return res.end();
	}

	peticiones.push(`${req.method === 'GET' ? '' : req.method + ' '}${p}`);
	const html = cuerpo => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(cuerpo); };

	if (p === '/a' || p === '/b') return html(pagina(p, ''));
	if (p === '/origen') return html(pagina('origen', ENLACES));
	if (p === '/hijo') return setTimeout(() => html(pagina('hijo', '')), +u.searchParams.get('ms') || 0);
	if (p === '/post') {
		let n = 0;
		req.on('data', d => { n += d.length; });
		return req.on('end', () => html(pagina('post', '', `data-metodo="${req.method}" data-bytes="${n}"`)));
	}
	if (p.startsWith('/dl/')) {
		res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${basename(p)}"` });
		return setTimeout(() => res.end(Buffer.alloc(65536)), 100);
	}
	if (p === '/binario') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(65536)); }
	if (p === '/redir') { res.writeHead(302, { Location: '/dl/redir.zip' }); return res.end(); }
	if (p === '/doc.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n'); }
	res.writeHead(404, { 'Content-Type': 'text/html' });
	res.end(pagina('404', ''));
});

// ---- Protocolo de DevTools --------------------------------------------------
class CDP {
	constructor(ws) {
		this.ws = ws;
		this.id = 0;
		this.pendientes = new Map();
		ws.onmessage = e => {
			const m = JSON.parse(e.data);
			const p = this.pendientes.get(m.id);

			if (p) {
				this.pendientes.delete(m.id);
				m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
			}
		};
	}

	enviar(method, params = {}, sessionId) {
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params, sessionId }));
		return new Promise((resolve, reject) => {
			this.pendientes.set(id, { resolve, reject });
			setTimeout(() => { if (this.pendientes.delete(id)) reject(new Error(`sin respuesta: ${method}`)); }, 8000);
		});
	}

	async evaluar(expression, sessionId) {
		const r = await this.enviar('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
		return r.result.value;
	}

	async enPestana(targetId, fn) {
		const { sessionId } = await this.enviar('Target.attachToTarget', { targetId, flatten: true });

		try {
			return await fn(sessionId);
		} finally {
			await this.enviar('Target.detachFromTarget', { sessionId }).catch(() => {});
		}
	}
}

async function pestanas(cdp) {
	const { targetInfos } = await cdp.enviar('Target.getTargets');
	// Las páginas internas del navegador (como el panel de descargas de Edge) no son pestañas.
	return targetInfos.filter(t => t.type === 'page' && /^(https?:|about:)/.test(t.url));
}

async function clic(cdp, s, selector, button) {
	const { x, y } = JSON.parse(await cdp.evaluar(`(()=>{const a=document.querySelector('${selector}');a.scrollIntoView({block:'center'});const r=a.getBoundingClientRect();return JSON.stringify({x:r.x+Math.min(r.width/2,10),y:r.y+r.height/2})})()`, s));
	await cdp.enviar('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, s);
	await cdp.enviar('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, s);
	await cdp.enviar('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, s);
}

// Pulsa un atajo del navegador (Ctrl+T, Ctrl+2…) como lo harías tú, no por una API.
async function atajo(cdp, targetId, tecla) {
	const codigo = tecla.toUpperCase().charCodeAt(0);
	const k = { modifiers: 2, windowsVirtualKeyCode: codigo, nativeVirtualKeyCode: codigo, key: tecla, code: (/\d/.test(tecla) ? 'Digit' : 'Key') + tecla.toUpperCase() };

	await cdp.enPestana(targetId, async s => {
		await cdp.enviar('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k }, s);
		await cdp.enviar('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, s);
	});
}

// Deja una sola pestaña con historial a, b, origen.
async function preparar(cdp, base) {
	const { targetId } = await cdp.enviar('Target.createTarget', { url: 'about:blank' });

	for (const t of await pestanas(cdp)) {
		if (t.targetId !== targetId) {
			await cdp.enviar('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
		}
	}

	await dormir(300);
	await cdp.enPestana(targetId, async s => {
		await cdp.enviar('Page.enable', {}, s);
		for (const u of ['/a', '/b', '/origen']) {
			await cdp.enviar('Page.navigate', { url: base + u }, s);
			await dormir(350);
		}
		await cdp.enviar('Target.activateTarget', { targetId });
	});
	peticiones = [];
	return targetId;
}

async function estado(cdp) {
	const lista = [];

	for (const t of await pestanas(cdp)) {
		await cdp.enPestana(t.targetId, async s => {
			lista.push(JSON.parse(await cdp.evaluar('JSON.stringify({ruta:location.pathname,hist:history.length,metodo:document.body?.dataset.metodo,bytes:+document.body?.dataset.bytes})', s)));
		}).catch(() => {});
	}

	return lista;
}

// ---- Escenarios -------------------------------------------------------------
const cuenta = ruta => peticiones.filter(p => p === ruta).length;
const nueva = lista => lista.find(t => t.ruta !== '/origen');

// Hereda el historial: las 3 páginas de origen, el about:blank del principio y la nueva.
const heredaHistorial = ruta => lista => lista.length === 2 && nueva(lista)?.ruta === ruta && nueva(lista).hist === 5;
// Una descarga: ni pestañas de más, ni dos peticiones, ni recargar el origen.
const descarga = archivo => lista => lista.length === 1 && cuenta(archivo) === 1 && cuenta('/origen') === 0;
const formulario = lista => lista.length === 2 && nueva(lista)?.metodo === 'POST' && nueva(lista).bytes > 0 && nueva(lista).hist === 1;

// Las pestañas de la ventana, de izquierda a derecha, vistas desde la extensión.
const TABS = 'chrome.tabs.query({}).then(t=>JSON.stringify(t.sort((a,b)=>a.index-b.index).map(x=>({u:x.url,a:x.active,p:x.pinned}))))';

const ESCENARIOS = [
	['Clic central en un enlace hereda el historial', '#hijo', 'middle', heredaHistorial('/hijo')],
	['target=_blank hereda el historial', '#blanco', 'left', heredaHistorial('/hijo')],
	['Una página 404 también lo hereda', '#roto', 'left', heredaHistorial('/no-existe')],
	['Un PDF también lo hereda', '#pdf', 'middle', heredaHistorial('/doc.pdf')],
	['Clic central en un adjunto: descarga intacta', '#adjunto', 'middle', descarga('/dl/adjunto.zip')],
	['target=_blank a un adjunto: descarga intacta', '#adjuntob', 'left', descarga('/dl/adjuntob.zip')],
	['Redirección a un adjunto: descarga intacta', '#redir', 'left', descarga('/dl/redir.zip')],
	['octet-stream: descarga intacta', '#binario', 'left', descarga('/binario')],
	['Atributo download: descarga intacta', '#atributo', 'left', descarga('/dl/atributo.zip')],
	['Un formulario POST conserva sus datos', '#post', 'left', formulario],
	['Un formulario POST por script conserva sus datos', '#postjs', 'left', formulario],
	['window.open() escrita por script no se toca', '#escrita', 'left', lista => lista.length === 2 && cuenta('/origen') === 0]
];

const ordenDe = tabs => tabs.map(t => /n=(\d)/.exec(t.u)?.[1] ?? 'o').join('');

// Abre r1 y r2, entra en r1 con el teclado, vuelve al origen y abre r3. Devuelve el orden resultante.
async function recorrido(cdp, base, enSW) {
	const id = await preparar(cdp, base);

	for (const selector of ['#r1', '#r2']) {
		await cdp.enPestana(id, s => clic(cdp, s, selector, 'middle'));
		await dormir(1500);
	}

	await atajo(cdp, id, '2');
	await dormir(600);
	await atajo(cdp, (await pestanas(cdp)).find(t => t.url.includes('n=1')).targetId, '1');
	await dormir(600);
	await cdp.enPestana(id, s => clic(cdp, s, '#r3', 'middle'));
	await dormir(1500);
	return ordenDe(JSON.parse(await enSW(TABS)));
}

async function ejecutar(cdp, base) {
	let fallos = 0;
	const informar = (ok, nombre, detalle) => {
		fallos += ok ? 0 : 1;
		console.log(`${ok ? 'ok   ' : 'FALLO'} ${nombre}${ok ? '' : `\n      ${detalle}`}`);
	};

	const { targetInfos } = await cdp.enviar('Target.getTargets');
	const sw = targetInfos.find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'));

	if (!sw) {
		throw new Error('La extensión no se ha cargado');
	}

	const enSW = expr => cdp.enPestana(sw.targetId, s => cdp.evaluar(expr, s));

	for (const [nombre, selector, boton, comprobar] of ESCENARIOS) {
		const id = await preparar(cdp, base);
		await cdp.enPestana(id, s => clic(cdp, s, selector, boton));
		await dormir(2500);
		const lista = await estado(cdp);
		informar(comprobar(lista), nombre, JSON.stringify({ lista, peticiones }));
	}

	// Una ráfaga sale en orden aunque las páginas respondan a destiempo, y sin quitarte la pestaña.
	for (const hueco of [0, 60, 200, 600]) {
		const id = await preparar(cdp, base);
		await cdp.enPestana(id, async s => {
			for (let i = 1; i <= 6; i++) {
				await clic(cdp, s, `#r${i}`, 'middle');
				await dormir(hueco);
			}
		});
		await dormir(4500);
		const tabs = JSON.parse(await enSW(TABS));
		const orden = ordenDe(tabs);
		const hist = (await estado(cdp)).filter(t => t.ruta === '/hijo').every(t => t.hist === 5);
		informar(orden === 'o123456' && hist && tabs.find(t => t.a)?.u.endsWith('/origen'), `Ráfaga de 6 clics cada ${hueco} ms, en orden`, JSON.stringify(tabs));
	}

	// Una pestaña nueva (Ctrl+T) en la que se escribe una dirección no es un enlace.
	let id = await preparar(cdp, base);
	await atajo(cdp, id, 't');
	await dormir(1000);
	const nuevaPestana = (await cdp.enviar('Target.getTargets')).targetInfos.find(t => t.type === 'page' && t.targetId !== id);

	if (nuevaPestana) {
		await cdp.enPestana(nuevaPestana.targetId, s => cdp.enviar('Page.navigate', { url: base + '/a', transitionType: 'typed' }, s));
		await dormir(2500);
	}

	let lista = await estado(cdp);
	informar(nuevaPestana && lista.length === 2 && nueva(lista)?.ruta === '/a' && nueva(lista).hist === 2 && cuenta('/a') === 1, 'Una pestaña nueva con Ctrl+T no se toca', JSON.stringify({ abierta: !!nuevaPestana, lista, peticiones }));

	// Un enlace abierto desde una pestaña fijada hereda el historial, pero no queda fijado.
	id = await preparar(cdp, base);
	await enSW("chrome.tabs.query({active:true}).then(([t])=>chrome.tabs.update(t.id,{pinned:true})).then(()=>'ok')");
	await cdp.enPestana(id, s => clic(cdp, s, '#hijo', 'middle'));
	await dormir(2500);
	const fijadas = JSON.parse(await enSW(TABS));
	informar(heredaHistorial('/hijo')(await estado(cdp)) && fijadas.find(t => t.u.endsWith('/hijo'))?.p === false && fijadas.find(t => t.u.endsWith('/origen'))?.p === true, 'Desde una pestaña fijada no queda fijada', JSON.stringify(fijadas));

	const conRonda = await recorrido(cdp, base, enSW);

	// Desactivada no interviene.
	await enSW("chrome.storage.local.set({enabled:false}).then(()=>'ok')");
	id = await preparar(cdp, base);
	await cdp.enPestana(id, s => clic(cdp, s, '#hijo', 'middle'));
	await dormir(1500);
	lista = await estado(cdp);
	informar(lista.length === 2 && nueva(lista)?.hist === 1 && cuenta('/hijo') === 1, 'Desactivada no interviene', JSON.stringify({ lista, peticiones }));

	// Con ella o sin ella, las pestañas acaban en el mismo sitio.
	const sinRonda = await recorrido(cdp, base, enSW);
	informar(conRonda === sinRonda, 'Coloca las pestañas igual que el navegador', JSON.stringify({ conRonda, sinRonda }));
	return fallos;
}

// ---- Arranque ---------------------------------------------------------------
const temporal = mkdtempSync(join(tmpdir(), 'ronda-'));
const extension = join(temporal, 'ext');
cpSync(raiz, extension, { recursive: true, filter: f => !/[\\/](\.git|test|node_modules)([\\/]|$)/.test(f.slice(raiz.length)) });
await new Promise(r => servidor.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${servidor.address().port}`;
const puerto = 9400 + Math.floor(Math.random() * 400);
const proceso = spawn(navegador, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${puerto}`, `--user-data-dir=${join(temporal, 'perfil')}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--window-size=1280,1400', 'about:blank'], { stdio: 'ignore' });
let fallos = 1;

try {
	let version;

	for (let i = 0; i < 30 && !version; i++) {
		await dormir(500);
		version = await fetch(`http://127.0.0.1:${puerto}/json/version`).then(r => r.json()).catch(() => null);
	}

	if (!version) {
		throw new Error('El navegador no ha abierto el puerto de depuración');
	}

	console.log(`# ${version.Browser}`);
	const ws = new WebSocket(version.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
	const cdp = new CDP(ws);
	await cdp.enviar('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: join(temporal, 'descargas') });
	await dormir(1500);
	fallos = await ejecutar(cdp, base);
	console.log(fallos ? `\n${fallos} fallos` : '\nTodo bien');
} catch (e) {
	console.error(e);
} finally {
	try {
		execFileSync('taskkill', ['/PID', String(proceso.pid), '/T', '/F'], { stdio: 'ignore' });
	} catch {
		proceso.kill();
	}
	servidor.closeAllConnections();
	servidor.close();
	await dormir(500);
	rmSync(temporal, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

process.exit(fallos ? 1 : 0);
