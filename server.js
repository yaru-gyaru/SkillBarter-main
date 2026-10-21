import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SKILLBARTER_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'skillbarter.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', city TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', skills TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'Русский', blocked INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 0 CHECK(available >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT NOT NULL DEFAULT '✦');
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), category_id INTEGER NOT NULL REFERENCES categories(id), title TEXT NOT NULL, description TEXT NOT NULL, level TEXT NOT NULL, language TEXT NOT NULL, format TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', min_minutes INTEGER NOT NULL, max_minutes INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER NOT NULL REFERENCES users(id), offer_id INTEGER NOT NULL REFERENCES offers(id), PRIMARY KEY(user_id, offer_id));
CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, offer_id INTEGER NOT NULL REFERENCES offers(id), customer_id INTEGER NOT NULL REFERENCES users(id), provider_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, format TEXT NOT NULL, minutes INTEGER NOT NULL, starts_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', note TEXT NOT NULL DEFAULT '', done_at TEXT, resolution TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), user_id INTEGER REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id), author_id INTEGER NOT NULL REFERENCES users(id), recipient_id INTEGER NOT NULL REFERENCES users(id), rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), body TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(request_id, author_id));
CREATE TABLE IF NOT EXISTS disputes (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL UNIQUE REFERENCES requests(id), opened_by INTEGER NOT NULL REFERENCES users(id), reason TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', resolution TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), request_id INTEGER REFERENCES requests(id), available_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES users(id), action TEXT NOT NULL, target TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_offers_catalog ON offers(active, hidden, category_id);
CREATE INDEX IF NOT EXISTS idx_requests_customer ON requests(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_provider ON requests(provider_id, status);
`);
if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'avatar_file')) db.exec('ALTER TABLE users ADD COLUMN avatar_file TEXT');

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
function hashPassword(password) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`; }
function checkPassword(password, stored) { const [salt, hash] = stored.split(':'); const actual = crypto.scryptSync(password, salt, 64); return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), actual); }
function clean(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function validMinutes(n) { return Number.isInteger(n) && n >= 30 && n <= 240 && n % 30 === 0; }
function notify(userId, body) { run('INSERT INTO notifications(user_id,body) VALUES(?,?)', userId, body); }
function wallet(userId, requestId, availableDelta, reservedDelta, type) {
  const result = run('UPDATE users SET available=available+?,reserved=reserved+? WHERE id=? AND available+?>=0 AND reserved+?>=0', availableDelta, reservedDelta, userId, availableDelta, reservedDelta);
  if (!result.changes) fail('Недостаточно минут на балансе');
  run('INSERT INTO transactions(user_id,request_id,available_delta,reserved_delta,type) VALUES(?,?,?,?,?)', userId, requestId, availableDelta, reservedDelta, type);
}
function event(requestId, body) { run('INSERT INTO messages(request_id,user_id,body) VALUES(?,NULL,?)', requestId, body); }
function audit(adminId, action, target, note = '') { run('INSERT INTO audit_log(admin_id,action,target,note) VALUES(?,?,?,?)', adminId, action, target, note); }
function seed() {
  if (one('SELECT COUNT(*) n FROM users').n) return;
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) throw new Error('Для первого запуска в production задайте ADMIN_PASSWORD');
  const demoPassword = process.env.DEMO_PASSWORD || 'Demo12345!';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin12345!';
  transaction(() => {
    for (const [name, email, password, role, city, bio, skills] of [
      ['Айару Кайрат','aiaru@skillbarter.local',demoPassword,'user','Алматы','Помогаю разобраться в программировании простыми словами.','JavaScript, Java, Веб-разработка'],
      ['Сымбат Кылыш','symbat@skillbarter.local',demoPassword,'user','Астана','Люблю языки и помогаю говорить увереннее.','Английский, Подготовка к IELTS'],
      ['Баянсулу Жойлоу','bayansulu@skillbarter.local',demoPassword,'user','Алматы','Дизайнер интерфейсов. Делюсь опытом и вдохновением.','Figma, UI-дизайн, Портфолио'],
      ['Кобеев Алмас','almas@skillbarter.local',demoPassword,'user','Алматы','Помогаю разбираться с планированием встреч и организацией проектов.','Планирование, Проекты, Веб-разработка'],
      ['Администратор','admin@skillbarter.local',adminPassword,'admin','Алматы','Команда SkillBarter','']
    ].filter(([, , , role]) => process.env.NODE_ENV !== 'production' || role === 'admin')) { const id=run('INSERT INTO users(name,email,password,role,city,bio,skills) VALUES(?,?,?,?,?,?,?)', name,email,hashPassword(password),role,city,bio,skills).lastInsertRowid; if(role==='user') wallet(Number(id),null,120,0,'START_BONUS'); }
    for (const [name, icon] of [['Разработка','⌘'],['Языки','◎'],['Дизайн','◈'],['Образование','✳'],['Карьера','↗'],['Другое','✦']]) run('INSERT INTO categories(name,icon) VALUES(?,?)',name,icon);
    if (process.env.NODE_ENV !== 'production') for (const [user,cat,title,description,level,format,city] of [
      [1,1,'Разберём JavaScript вместе','Помогу понять основы JavaScript, разобраться с задачами и собрать первый проект. Объясняю спокойно и на практике.','Начинающий','Онлайн',''],
      [1,1,'Первый проект на Java','От структуры проекта до работающего приложения: разберём классы, коллекции и типичные ошибки.','Начинающий','Онлайн',''],
      [2,2,'Разговорный английский без страха','Живая практика с дружелюбной обратной связью. Подберём темы под ваши интересы и цели.','Любой','Онлайн',''],
      [2,4,'Подготовка к IELTS Speaking','Проработаем структуру ответов и потренируем реальные задания экзамена.','Средний','Онлайн',''],
      [3,3,'Основы UI-дизайна в Figma','Покажу, как построить понятный интерфейс: сетки, типографика, компоненты и макеты.','Начинающий','Онлайн',''],
      [3,5,'Разбор дизайн-портфолио','Посмотрим ваши кейсы и составим план, как сделать портфолио убедительнее.','Любой','Офлайн','Алматы']
    ]) run('INSERT INTO offers(user_id,category_id,title,description,level,language,format,city,min_minutes,max_minutes) VALUES(?,?,?,?,?,?,?,?,30,120)',user,cat,title,description,level,'Русский',format,city);
  });
}
seed();
// Обновляет только известные демонстрационные записи в уже созданной локальной базе.
if (process.env.NODE_ENV !== 'production') transaction(() => {
  run("UPDATE users SET name='Айару Кайрат' WHERE email='aiaru@skillbarter.local' AND name IN ('Айару Садыкова','Айару Сыдыкова')");
  if (!one('SELECT id FROM users WHERE email=?','almas@skillbarter.local')) {
    const id=run('INSERT INTO users(name,email,password,role,city,bio,skills) VALUES(?,?,?,?,?,?,?)','Кобеев Алмас','almas@skillbarter.local',hashPassword(process.env.DEMO_PASSWORD||'Demo12345!'),'user','Алматы','Помогаю разбираться с планированием встреч и организацией проектов.','Планирование, Проекты, Веб-разработка').lastInsertRowid;
    wallet(Number(id),null,120,0,'START_BONUS');
  }
});

function publicUser(user) { if (!user) return null; const { password, ...safe } = user; return safe; }
function currentUser(req) {
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)sb_session=([^;]+)/)?.[1];
  if (!cookie) return null;
  return one("SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires_at>datetime('now') AND u.blocked=0",cookie) || null;
}
function requireUser(user) { if (!user) fail('Войдите в аккаунт',401); return user; }
function requireAdmin(user) { requireUser(user); if (user.role !== 'admin') fail('Доступ только для администратора',403); return user; }
function send(res, status, data, extra = {}) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra}); res.end(JSON.stringify(data)); }
async function body(req) { let raw=''; for await (const chunk of req) { raw += chunk; if (raw.length > 1_200_000) fail('Слишком большой запрос',413); } try { return raw ? JSON.parse(raw) : {}; } catch { fail('Неверный JSON'); } }
const routes = [];
function route(method, pattern, handler) { routes.push({method,pattern,handler}); }
const offerSql = `SELECT o.*,c.name category,c.icon category_icon,u.name provider,u.city provider_city,u.skills provider_skills,u.avatar_file provider_avatar,
  COALESCE((SELECT ROUND(AVG(r.rating),1) FROM reviews r WHERE r.recipient_id=u.id AND r.hidden=0),0) rating,
  (SELECT COUNT(*) FROM reviews r WHERE r.recipient_id=u.id AND r.hidden=0) review_count
  FROM offers o JOIN categories c ON c.id=o.category_id JOIN users u ON u.id=o.user_id`;
const requestSql = `SELECT r.*,cu.name customer,pu.name provider,o.category_id FROM requests r JOIN users cu ON cu.id=r.customer_id JOIN users pu ON pu.id=r.provider_id JOIN offers o ON o.id=r.offer_id`;
route('GET', /^\/api\/bootstrap$/, (req,res,user) => send(res,200,{user:publicUser(user),categories:all('SELECT * FROM categories ORDER BY id'),notifications:user ? all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 15',user.id):[]}));
route('POST', /^\/api\/auth\/(register|login|logout)$/, async (req,res,user,m) => {
  if (m[1]==='logout') { const token=req.headers.cookie?.match(/(?:^|;\s*)sb_session=([^;]+)/)?.[1]; if(token) run('DELETE FROM sessions WHERE token=?',token); return send(res,200,{ok:true},{'Set-Cookie':'sb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'}); }
  const b=await body(req); const email=clean(b.email,180).toLowerCase(), password=String(b.password||'');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length<8) fail('Укажите корректную почту и пароль от 8 символов');
  let account;
  if (m[1]==='register') {
    const name=clean(b.name,80); if(name.length<2) fail('Имя должно содержать минимум 2 символа');
    if(one('SELECT id FROM users WHERE email=?',email)) fail('Эта почта уже зарегистрирована',409);
    account=transaction(()=>{ const id=run('INSERT INTO users(name,email,password) VALUES(?,?,?)',name,email,hashPassword(password)).lastInsertRowid; wallet(Number(id),null,120,0,'START_BONUS'); return one('SELECT * FROM users WHERE id=?',id); });
  } else { account=one('SELECT * FROM users WHERE email=?',email); if(!account || !checkPassword(password,account.password)) fail('Неверная почта или пароль',401); if(account.blocked) fail('Аккаунт заблокирован',403); }
  const token=crypto.randomBytes(32).toString('hex'); run("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','+30 days'))",token,account.id);
  send(res,200,{user:publicUser(account)},{'Set-Cookie':`sb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${process.env.NODE_ENV==='production'?'; Secure':''}`});
});
route('PATCH', /^\/api\/profile$/, async(req,res,user)=>{ requireUser(user); const b=await body(req); const name=clean(b.name,80),city=clean(b.city,80),bio=clean(b.bio,600),skills=clean(b.skills,250),language=clean(b.language,60); if(name.length<2) fail('Укажите имя'); run('UPDATE users SET name=?,city=?,bio=?,skills=?,language=? WHERE id=?',name,city,bio,skills,language,user.id); send(res,200,{user:publicUser(one('SELECT * FROM users WHERE id=?',user.id))}); });
route('POST', /^\/api\/profile\/avatar$/, async(req,res,user)=>{
  requireUser(user);const b=await body(req),data=String(b.image||''),match=/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if(!match)fail('Выберите изображение PNG');
  const bytes=Buffer.from(match[1],'base64');
  if(bytes.length>700_000||bytes.length<45||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR'||bytes.readUInt32BE(16)>512||bytes.readUInt32BE(20)>512)fail('Изображение должно быть PNG до 700 КБ и 512 × 512 пикселей');
  const avatarDir=path.join(dataDir,'avatars');fs.mkdirSync(avatarDir,{recursive:true});const filename=`user-${user.id}.png`;fs.writeFileSync(path.join(avatarDir,filename),bytes);run('UPDATE users SET avatar_file=? WHERE id=?',`/avatars/${filename}`,user.id);
  send(res,200,{user:publicUser(one('SELECT * FROM users WHERE id=?',user.id))});
});
route('GET', /^\/api\/users\/(\d+)$/, (req,res,user,m)=>{ const u=one('SELECT id,name,city,bio,skills,language,avatar_file,created_at FROM users WHERE id=? AND blocked=0',Number(m[1])); if(!u) fail('Профиль не найден',404); send(res,200,{user:u,offers:all(offerSql+' WHERE o.user_id=? AND o.active=1 AND o.hidden=0',u.id),reviews:all('SELECT r.*,a.name author FROM reviews r JOIN users a ON a.id=r.author_id WHERE r.recipient_id=? AND r.hidden=0 ORDER BY r.id DESC',u.id)}); });
route('GET', /^\/api\/offers$/, (req,res,user)=>{ const u=new URL(req.url,'http://localhost'); const q=clean(u.searchParams.get('q'),100),category=Number(u.searchParams.get('category')||0),format=clean(u.searchParams.get('format'),40),city=clean(u.searchParams.get('city'),80),language=clean(u.searchParams.get('language'),60),sort=u.searchParams.get('sort'); let sql=offerSql+' WHERE o.active=1 AND o.hidden=0 AND u.blocked=0', p=[]; if(q){sql+=' AND (o.title LIKE ? OR o.description LIKE ? OR u.name LIKE ?)';p.push(...Array(3).fill(`%${q}%`));} if(category){sql+=' AND o.category_id=?';p.push(category);} if(format){sql+=' AND o.format=?';p.push(format);} if(city){sql+=' AND (o.city LIKE ? OR u.city LIKE ?)';p.push(`%${city}%`,`%${city}%`);} if(language){sql+=' AND o.language=?';p.push(language);} sql+=sort==='rating'?' ORDER BY rating DESC,o.id DESC':' ORDER BY o.id DESC'; const page=Math.max(1,Number(u.searchParams.get('page'))||1),limit=9; const rows=all(sql,...p); send(res,200,{offers:rows.slice((page-1)*limit,page*limit),total:rows.length,page,pages:Math.max(1,Math.ceil(rows.length/limit)),favorites:user?all('SELECT offer_id FROM favorites WHERE user_id=?',user.id).map(x=>x.offer_id):[]}); });
route('GET', /^\/api\/offers\/(\d+)$/, (req,res,user,m)=>{ const offer=one(offerSql+' WHERE o.id=? AND o.hidden=0 AND o.active=1',Number(m[1])); if(!offer) fail('Предложение не найдено',404); send(res,200,{offer,favorite:!!(user&&one('SELECT 1 FROM favorites WHERE user_id=? AND offer_id=?',user.id,offer.id))}); });
route('GET', /^\/api\/my-offers$/, (req,res,user)=>{ requireUser(user); send(res,200,{offers:all(offerSql+' WHERE o.user_id=? ORDER BY o.id DESC',user.id)}); });
route('POST', /^\/api\/offers$/, async(req,res,user)=>{ requireUser(user); if(user.role==='admin') fail('Администратор не публикует услуги',403); const b=await body(req),title=clean(b.title,100),description=clean(b.description,1000),category=Number(b.category_id),min=Number(b.min_minutes),max=Number(b.max_minutes),format=clean(b.format,20),city=clean(b.city,80),level=clean(b.level,30),language=clean(b.language,60); if(title.length<5||description.length<20||!one('SELECT id FROM categories WHERE id=?',category)||!validMinutes(min)||!validMinutes(max)||min>max||!['Онлайн','Офлайн'].includes(format)||!['Начинающий','Средний','Продвинутый','Любой'].includes(level)||!language||(format==='Офлайн'&&!city)) fail('Проверьте поля предложения'); const id=run('INSERT INTO offers(user_id,category_id,title,description,level,language,format,city,min_minutes,max_minutes) VALUES(?,?,?,?,?,?,?,?,?,?)',user.id,category,title,description,level,language,format,city,min,max).lastInsertRowid; send(res,201,{id:Number(id)}); });
route('PATCH', /^\/api\/offers\/(\d+)$/, async(req,res,user,m)=>{ requireUser(user); const id=Number(m[1]),offer=one('SELECT * FROM offers WHERE id=?',id); if(!offer) fail('Предложение не найдено',404); if(offer.user_id!==user.id) fail('Нет доступа',403); const b=await body(req),active=b.active===undefined?offer.active:(b.active?1:0); run('UPDATE offers SET active=? WHERE id=?',active,id); send(res,200,{ok:true}); });
route('POST', /^\/api\/favorites\/(\d+)$/, (req,res,user,m)=>{ requireUser(user); const id=Number(m[1]); if(!one('SELECT 1 FROM offers WHERE id=? AND active=1 AND hidden=0',id)) fail('Предложение не найдено',404); const existing=one('SELECT 1 FROM favorites WHERE user_id=? AND offer_id=?',user.id,id); if(existing) run('DELETE FROM favorites WHERE user_id=? AND offer_id=?',user.id,id); else run('INSERT INTO favorites(user_id,offer_id) VALUES(?,?)',user.id,id); send(res,200,{favorite:!existing}); });
route('GET', /^\/api\/favorites$/, (req,res,user)=>{ requireUser(user); send(res,200,{offers:all(offerSql+' JOIN favorites f ON f.offer_id=o.id WHERE f.user_id=? AND o.active=1 AND o.hidden=0',user.id)}); });
route('POST', /^\/api\/requests$/, async(req,res,user)=>{ requireUser(user); if(user.role==='admin') fail('Администратор не создаёт заявки',403); const b=await body(req),offer=one('SELECT * FROM offers WHERE id=? AND active=1 AND hidden=0',Number(b.offer_id)),minutes=Number(b.minutes),starts=new Date(b.starts_at); if(!offer) fail('Предложение не найдено',404); if(offer.user_id===user.id) fail('Нельзя заказать собственную услугу'); if(!validMinutes(minutes)||minutes<offer.min_minutes||minutes>offer.max_minutes) fail('Недопустимая длительность'); if(Number.isNaN(starts.getTime())||starts.getTime()<Date.now()+15*60_000) fail('Выберите будущее время, минимум через 15 минут'); if(offer.format!==clean(b.format,20)) fail('Формат не соответствует предложению'); const id=run('INSERT INTO requests(offer_id,customer_id,provider_id,title,format,minutes,starts_at,note) VALUES(?,?,?,?,?,?,?,?)',offer.id,user.id,offer.user_id,offer.title,offer.format,minutes,starts.toISOString(),clean(b.note,500)).lastInsertRowid; notify(offer.user_id,`Новая заявка на «${offer.title}»`); send(res,201,{id:Number(id)}); });
route('GET', /^\/api\/requests$/, (req,res,user)=>{ requireUser(user); send(res,200,{requests:all(requestSql+' WHERE r.customer_id=? OR r.provider_id=? ORDER BY r.id DESC',user.id,user.id)}); });
route('GET', /^\/api\/requests\/(\d+)$/, (req,res,user,m)=>{ requireUser(user); const r=one(requestSql+' WHERE r.id=?',Number(m[1])); if(!r) fail('Заявка не найдена',404); if(user.role!=='admin'&&r.customer_id!==user.id&&r.provider_id!==user.id) fail('Нет доступа',403); send(res,200,{request:r,messages:all('SELECT m.*,u.name author FROM messages m LEFT JOIN users u ON u.id=m.user_id WHERE m.request_id=? ORDER BY m.id',r.id),dispute:one('SELECT * FROM disputes WHERE request_id=?',r.id)||null,reviews:all('SELECT * FROM reviews WHERE request_id=?',r.id)}); });
route('POST', /^\/api\/requests\/(\d+)\/(accept|reject|cancel|mark-done|confirm|dispute)$/, async(req,res,user,m)=>{
  requireUser(user); const id=Number(m[1]),action=m[2],b=await body(req); const r=one('SELECT * FROM requests WHERE id=?',id); if(!r) fail('Заявка не найдена',404); if(r.customer_id!==user.id&&r.provider_id!==user.id) fail('Нет доступа',403);
  transaction(()=>{
    if(action==='accept') { if(r.provider_id!==user.id||r.status!=='PENDING') fail('Заявку нельзя принять'); if(new Date(r.starts_at).getTime()<Date.now()) fail('Время встречи уже прошло'); const end=new Date(r.starts_at).getTime()+r.minutes*60_000; const conflict=one("SELECT id FROM requests WHERE status IN ('ACCEPTED','AWAITING_CONFIRMATION','DISPUTED') AND (customer_id IN (?,?) OR provider_id IN (?,?)) AND julianday(starts_at)<julianday(?) AND julianday(starts_at)+minutes/1440.0>julianday(?) LIMIT 1",r.customer_id,r.provider_id,r.customer_id,r.provider_id,new Date(end).toISOString(),r.starts_at); if(conflict) fail('Это время пересекается с другой встречей'); wallet(r.customer_id,id,-r.minutes,r.minutes,'RESERVE'); run("UPDATE requests SET status='ACCEPTED' WHERE id=? AND status='PENDING'",id); event(id,'Заявка принята. Минуты зарезервированы.'); notify(r.customer_id,`Заявка «${r.title}» принята`); }
    else if(action==='reject') { if(r.provider_id!==user.id||r.status!=='PENDING') fail('Заявку нельзя отклонить'); run("UPDATE requests SET status='REJECTED' WHERE id=?",id); event(id,'Исполнитель отклонил заявку.'); notify(r.customer_id,`Заявка «${r.title}» отклонена`); }
    else if(action==='cancel') { if(r.status==='PENDING'&&r.customer_id===user.id) {} else if(r.status==='ACCEPTED'&&Date.now()<new Date(r.starts_at).getTime()) wallet(r.customer_id,id,r.minutes,-r.minutes,'RELEASE'); else fail('Отмена сейчас недоступна: откройте спор'); run("UPDATE requests SET status='CANCELLED' WHERE id=?",id); event(id,'Заявка отменена.'); notify(r.customer_id===user.id?r.provider_id:r.customer_id,`Заявка «${r.title}» отменена`); }
    else if(action==='mark-done') { if(r.provider_id!==user.id||r.status!=='ACCEPTED'||Date.now()<new Date(r.starts_at).getTime()+r.minutes*60_000) fail('Отметить выполнение можно после окончания встречи'); run("UPDATE requests SET status='AWAITING_CONFIRMATION',done_at=CURRENT_TIMESTAMP WHERE id=?",id); event(id,'Исполнитель отметил услугу оказанной.'); notify(r.customer_id,`Подтвердите выполнение «${r.title}»`); }
    else if(action==='confirm') { if(r.customer_id!==user.id||r.status!=='AWAITING_CONFIRMATION') fail('Подтверждение недоступно'); wallet(r.customer_id,id,0,-r.minutes,'SPEND'); wallet(r.provider_id,id,r.minutes,0,'EARN'); run("UPDATE requests SET status='COMPLETED' WHERE id=?",id); event(id,'Обмен завершён. Минуты переведены исполнителю.'); notify(r.provider_id,`Обмен «${r.title}» завершён`); }
    else { if(!['ACCEPTED','AWAITING_CONFIRMATION'].includes(r.status)) fail('Спор недоступен'); const reason=clean(b.reason,100),description=clean(b.description,1000); if(reason.length<3||description.length<10) fail('Опишите причину спора'); if(r.status==='ACCEPTED'&&Date.now()<new Date(r.starts_at).getTime()) fail('До начала встречи можно отменить заявку'); if(r.status==='AWAITING_CONFIRMATION'&&r.provider_id===user.id&&Date.now()<new Date(r.done_at+' UTC').getTime()+48*3600_000) fail('Исполнитель может открыть спор через 48 часов'); run("UPDATE requests SET status='DISPUTED' WHERE id=?",id); run('INSERT INTO disputes(request_id,opened_by,reason,description) VALUES(?,?,?,?)',id,user.id,reason,description); event(id,'Открыт спор: '+reason); notify(r.customer_id===user.id?r.provider_id:r.customer_id,`Открыт спор по заявке «${r.title}»`); }
  }); send(res,200,{ok:true});
});
route('POST', /^\/api\/requests\/(\d+)\/messages$/, async(req,res,user,m)=>{ requireUser(user); const id=Number(m[1]),r=one('SELECT * FROM requests WHERE id=?',id); if(!r||![r.customer_id,r.provider_id].includes(user.id)||!['ACCEPTED','AWAITING_CONFIRMATION','DISPUTED','COMPLETED','RESOLVED'].includes(r.status)) fail('Чат недоступен',403); const b=await body(req),message=clean(b.message,2000); if(!message) fail('Напишите сообщение'); run('INSERT INTO messages(request_id,user_id,body) VALUES(?,?,?)',id,user.id,message); notify(r.customer_id===user.id?r.provider_id:r.customer_id,`Новое сообщение по заявке «${r.title}»`); send(res,201,{ok:true}); });
route('POST', /^\/api\/requests\/(\d+)\/reviews$/, async(req,res,user,m)=>{ requireUser(user); const r=one('SELECT * FROM requests WHERE id=?',Number(m[1])); if(!r||r.status!=='COMPLETED'||![r.customer_id,r.provider_id].includes(user.id)) fail('Отзыв недоступен',403); const b=await body(req),rating=Number(b.rating),comment=clean(b.body,800); if(!Number.isInteger(rating)||rating<1||rating>5||comment.length<5) fail('Укажите оценку и отзыв'); const recipient=r.customer_id===user.id?r.provider_id:r.customer_id; try { run('INSERT INTO reviews(request_id,author_id,recipient_id,rating,body) VALUES(?,?,?,?,?)',r.id,user.id,recipient,rating,comment); } catch { fail('Вы уже оставили отзыв',409); } notify(recipient,'У вас новый отзыв'); send(res,201,{ok:true}); });
route('GET', /^\/api\/wallet$/, (req,res,user)=>{ requireUser(user); send(res,200,{available:one('SELECT available FROM users WHERE id=?',user.id).available,reserved:one('SELECT reserved FROM users WHERE id=?',user.id).reserved,transactions:all('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 50',user.id)}); });
route('POST', /^\/api\/notifications\/read$/, (req,res,user)=>{ requireUser(user); run('UPDATE notifications SET read=1 WHERE user_id=?',user.id); send(res,200,{ok:true}); });
route('GET', /^\/api\/admin\/dashboard$/, (req,res,user)=>{ requireAdmin(user); send(res,200,{stats:{users:one("SELECT COUNT(*) n FROM users WHERE role='user'").n,admins:one("SELECT COUNT(*) n FROM users WHERE role='admin'").n,offers:one('SELECT COUNT(*) n FROM offers WHERE active=1 AND hidden=0').n,requests:one('SELECT COUNT(*) n FROM requests').n,disputes:one("SELECT COUNT(*) n FROM disputes WHERE status='OPEN'").n},disputes:all('SELECT d.*,r.title,r.minutes,cu.name customer,pu.name provider FROM disputes d JOIN requests r ON r.id=d.request_id JOIN users cu ON cu.id=r.customer_id JOIN users pu ON pu.id=r.provider_id ORDER BY d.id DESC'),users:all('SELECT id,name,email,city,role,blocked,available,reserved,created_at FROM users ORDER BY id DESC'),offers:all(offerSql+' ORDER BY o.id DESC'),reviews:all('SELECT r.*,a.name author,u.name recipient FROM reviews r JOIN users a ON a.id=r.author_id JOIN users u ON u.id=r.recipient_id ORDER BY r.id DESC'),categories:all('SELECT * FROM categories ORDER BY id'),audit:all('SELECT a.*,u.name admin FROM audit_log a JOIN users u ON u.id=a.admin_id ORDER BY a.id DESC LIMIT 30')}); });
route('POST', /^\/api\/admin\/users$/, async(req,res,user)=>{
  requireAdmin(user);const b=await body(req),name=clean(b.name,80),email=clean(b.email,180).toLowerCase(),password=String(b.password||''),role=clean(b.role,10);
  if(name.length<2||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||!['user','admin'].includes(role)) fail('Проверьте имя, почту, пароль и роль');
  if(one('SELECT id FROM users WHERE email=?',email)) fail('Эта почта уже зарегистрирована',409);
  const id=transaction(()=>{const id=Number(run('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)',name,email,hashPassword(password),role).lastInsertRowid);if(role==='user')wallet(id,null,120,0,'START_BONUS');audit(user.id,'CREATE_USER',`user:${id}`,`Роль: ${role}`);return id;});
  send(res,201,{id,role});
});
route('PATCH', /^\/api\/admin\/users\/(\d+)\/role$/, async(req,res,user,m)=>{
  requireAdmin(user);const id=Number(m[1]),b=await body(req),role=clean(b.role,10),note=clean(b.note,300),target=one('SELECT id,role,blocked FROM users WHERE id=?',id);
  if(!target)fail('Пользователь не найден',404);if(!['user','admin'].includes(role)||note.length<3)fail('Выберите роль и укажите причину');
  if(target.role===role)fail('Роль уже назначена',409);if(id===user.id)fail('Нельзя изменить собственную роль',403);if(target.blocked&&role==='admin')fail('Сначала разблокируйте пользователя');
  transaction(()=>{run('UPDATE users SET role=? WHERE id=?',role,id);run('DELETE FROM sessions WHERE user_id=?',id);audit(user.id,'CHANGE_ROLE',`user:${id}`,`${target.role} → ${role}. ${note}`);});
  send(res,200,{id,role});
});
route('POST', /^\/api\/admin\/disputes\/(\d+)\/resolve$/, async(req,res,user,m)=>{ requireAdmin(user); const b=await body(req),resolution=clean(b.resolution,20),note=clean(b.note,500),d=one('SELECT d.*,r.customer_id,r.provider_id,r.minutes,r.title,r.status request_status FROM disputes d JOIN requests r ON r.id=d.request_id WHERE d.id=?',Number(m[1])); if(!d||d.status!=='OPEN'||d.request_status!=='DISPUTED') fail('Спор уже рассмотрен',409); if(!['refund','transfer'].includes(resolution)||note.length<5) fail('Выберите решение и укажите причину'); transaction(()=>{ if(resolution==='refund') wallet(d.customer_id,d.request_id,d.minutes,-d.minutes,'DISPUTE_REFUND'); else {wallet(d.customer_id,d.request_id,0,-d.minutes,'DISPUTE_SPEND');wallet(d.provider_id,d.request_id,d.minutes,0,'DISPUTE_EARN');} run("UPDATE disputes SET status='RESOLVED',resolution=? WHERE id=?",resolution,d.id); run("UPDATE requests SET status='RESOLVED',resolution=? WHERE id=?",resolution,d.request_id); event(d.request_id,`Спор рассмотрен: ${resolution==='refund'?'минуты возвращены заказчику':'минуты переведены исполнителю'}. ${note}`); audit(user.id,'RESOLVE_DISPUTE',`dispute:${d.id}`,note); notify(d.customer_id,`Спор по «${d.title}» рассмотрен`); notify(d.provider_id,`Спор по «${d.title}» рассмотрен`); }); send(res,200,{ok:true}); });
route('POST', /^\/api\/admin\/(users|offers|reviews)\/(\d+)\/toggle$/, async(req,res,user,m)=>{ requireAdmin(user); const kind=m[1],id=Number(m[2]),b=await body(req),note=clean(b.note,300); if(note.length<3) fail('Укажите причину действия'); if(kind==='users'){const target=one("SELECT * FROM users WHERE id=? AND role='user'",id);if(!target)fail('Пользователь не найден',404);run('UPDATE users SET blocked=? WHERE id=?',target.blocked?0:1,id); if(!target.blocked) run('DELETE FROM sessions WHERE user_id=?',id);} else if(kind==='offers'){const target=one('SELECT * FROM offers WHERE id=?',id);if(!target)fail('Предложение не найдено',404);run('UPDATE offers SET hidden=? WHERE id=?',target.hidden?0:1,id);} else {const target=one('SELECT * FROM reviews WHERE id=?',id);if(!target)fail('Отзыв не найден',404);run('UPDATE reviews SET hidden=? WHERE id=?',target.hidden?0:1,id);} audit(user.id,`TOGGLE_${kind.toUpperCase()}`,`${kind}:${id}`,note); send(res,200,{ok:true}); });
route('POST', /^\/api\/admin\/categories$/, async(req,res,user)=>{requireAdmin(user);const b=await body(req),name=clean(b.name,60),icon=clean(b.icon,4)||'✦';if(name.length<2)fail('Укажите название категории');try {const id=run('INSERT INTO categories(name,icon) VALUES(?,?)',name,icon).lastInsertRowid;audit(user.id,'ADD_CATEGORY',`category:${id}`,name);send(res,201,{id:Number(id)});}catch{fail('Категория уже существует',409);}});

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{ try {
  const url=new URL(req.url,'http://localhost');
  if(req.method!=='GET'&&req.method!=='HEAD'&&req.headers.origin){ const origin=new URL(req.headers.origin); if(origin.host!==req.headers.host) fail('Недопустимый источник запроса',403); }
  if(url.pathname.startsWith('/api/')){const user=currentUser(req); const found=routes.find(r=>r.method===req.method&&r.pattern.test(url.pathname));if(!found)fail('Маршрут не найден',404);return await found.handler(req,res,user,url.pathname.match(found.pattern));}
  const avatarMatch=/^\/avatars\/user-(\d+)\.png$/.exec(url.pathname);
  if(avatarMatch){const owner=one('SELECT avatar_file FROM users WHERE id=? AND blocked=0',Number(avatarMatch[1]));if(!owner||owner.avatar_file!==url.pathname)fail('Аватар не найден',404);const file=path.join(dataDir,'avatars',`user-${avatarMatch[1]}.png`);if(!fs.existsSync(file))fail('Аватар не найден',404);res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res);return;}
  const target=url.pathname==='/'||url.pathname==='/admin'?'/index.html':url.pathname;
  const file=path.resolve(root,'public',`./${target.replace(/^\//,'')}`);
  if(!file.startsWith(path.join(root,'public')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()) fail('Страница не найдена',404);
  res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});fs.createReadStream(file).pipe(res);
 } catch(e){if(!res.headersSent)send(res,e.status||500,{error:e.status?e.message:'Внутренняя ошибка сервера'}); console.error(e.status?`${e.status} ${e.message}`:e);}});
const port=Number(process.env.PORT)||3000;
server.listen(port,()=>console.log(`SkillBarter: http://localhost:${port}`));
export { server, db };
