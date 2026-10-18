/* 自动生成, 请勿手改 —— 由 scripts/build-text-plugin.ts 从 runtime.mjs + es_es/dict.json 生成 */
/* 作用: 把英雄联盟**客户端界面**的中文替换成目标语言。只改客户端页面里的文字, */
/*       不涉及任何文件, 也不涉及局内游戏(局内是另一个进程, 本插件碰不到)。 */
(() => {
/**
 * 客户端界面文字替换核心(运行在英雄联盟客户端页面里)。
 *
 * 设计约束:
 * - 只用浏览器标准接口(MutationObserver / requestAnimationFrame / localStorage / clipboard),
 *   不依赖任何加载器的私有 API, 所以换成别的加载器也能用。
 * - 整个能力集中在这一个自包含函数里(不引用外部变量), 打包时直接把它转成字符串塞进插件,
 *   因此这里改成任何东西都不需要改打包脚本。
 * - 任何异常都必须自我禁用: 最坏情况是"没翻译", 绝不能把客户端界面搞卡死。
 */

/** 含中日韩文字才算"需要翻译"的原文。 */
const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 这些标签里的文字绝不动。 */
const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS", "IFRAME", "TITLE", "HEAD"];

/** 默认不动的区域: 输入框、可编辑区(聊天框、昵称编辑等)。 */
const DEFAULT_SKIP_SELECTORS = ["[contenteditable='true']", "[contenteditable='']", "input", "textarea", "select"];

/**
 * 把一段文字翻译成目标语言。
 * 返回 null 表示"没有对应译文, 保持原样"。
 * 前后空白原样保留, 只有中间的主体参与查表 —— 界面文字常带缩进和换行。
 */
function translate(text, dict, patterns) {
  if (typeof text !== "string" || text.length === 0) return null;
  const leading = text.match(/^\s*/)[0];
  const trailing = text.match(/\s*$/)[0];
  const core = text.slice(leading.length, text.length - trailing.length);
  if (!core || !CJK.test(core)) return null;
  const direct = Object.prototype.hasOwnProperty.call(dict, core) ? dict[core] : undefined;
  if (typeof direct === "string" && direct.length > 0) return leading + direct + trailing;
  if (patterns) {
    for (let i = 0; i < patterns.length; i += 1) {
      const [re, to] = patterns[i];
      if (re.test(core)) return leading + core.replace(re, to) + trailing;
    }
  }
  return null;
}

/** 是否值得记录进"待翻译清单"(含中文、长度适中、还没有译文)。 */
function isCollectable(text, dict, maxLength) {
  if (typeof text !== "string") return false;
  const core = text.trim();
  if (!core || core.length > maxLength) return false;
  if (!CJK.test(core)) return false;
  return !Object.prototype.hasOwnProperty.call(dict, core);
}

/**
 * 安装文字替换器。返回一个控制器(可 off/on/dump/stats), 出任何问题都自动禁用自己。
 * options: { dict, patterns, collect, maxLength, skipSelectors, storageKey, debug }
 */
function createTextReplacer(options) {
  const opts = options || {};
  const dict = opts.dict || {};
  const patterns = opts.patterns || [];
  const collect = opts.collect !== false;
  const maxLength = typeof opts.maxLength === "number" ? opts.maxLength : 40;
  const skipSelectors = opts.skipSelectors || ["[contenteditable='true']", "input", "textarea"];
  const storageKey = opts.storageKey || "__tr_collected";
  const SKIP_TAGS = ["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "SVG", "CANVAS", "IFRAME", "TITLE", "HEAD"];
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const state = { on: true, replaced: 0, scanned: 0, failed: 0, error: "" };
  const written = new WeakMap();
  const pending = new Set();
  const collected = new Set();
  let scheduled = false;

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) for (const item of JSON.parse(saved)) collected.add(item);
  } catch (error) { /* 存储不可用不影响替换 */ }

  function saveCollection() {
    try { window.localStorage.setItem(storageKey, JSON.stringify([...collected])); } catch (error) { /* 忽略 */ }
  }

  function shouldSkip(element) {
    let node = element;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 40) {
      const tag = node.tagName;
      if (tag && SKIP_TAGS.indexOf(tag) >= 0) return true;
      if (tag === "BODY" || tag === "HTML") return false;
      for (let i = 0; i < skipSelectors.length; i += 1) {
        try { if (node.matches && node.matches(skipSelectors[i])) return true; } catch (error) { /* 选择器不合法就忽略 */ }
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }

  function handleTextNode(node) {
    const value = node.nodeValue;
    if (typeof value !== "string" || value.length === 0) return;
    if (written.get(node) === value) return;            // 是我们自己刚写的, 不要再动
    state.scanned += 1;
    const parent = node.parentElement;
    if (parent && shouldSkip(parent)) return;
    const result = translate(value, dict, patterns);
    if (result !== null) {
      if (result === value) return;
      written.set(node, result);
      try { node.nodeValue = result; state.replaced += 1; } catch (error) { state.failed += 1; }
      return;
    }
    if (collect) {
      const core = value.trim();
      if (core.length > 0 && core.length <= maxLength && CJK.test(core) && !collected.has(core)) {
        collected.add(core);
        saveCollection();
      }
    }
  }

  /** 手动深度优先遍历(不用 TreeWalker, 因为要能递归进 shadow root, 也好测试)。 */
  function walk(root, depth) {
    if (!state.on || !root || depth > 60) return;
    const children = root.childNodes;
    if (children) {
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        if (child.nodeType === 3) handleTextNode(child);
        else if (child.nodeType === 1) {
          if (child.shadowRoot) { observe(child.shadowRoot); walk(child.shadowRoot, depth + 1); }
          walk(child, depth + 1);
        }
      }
    }
    if (root.shadowRoot && root.nodeType === 1) { observe(root.shadowRoot); walk(root.shadowRoot, depth + 1); }
  }

  function flush() {
    scheduled = false;
    if (!state.on) return;
    if (state.error) return;
    const queue = [...pending];
    pending.clear();
    try {
      for (const node of queue) {
        if (!node.isConnected) continue;
        if (node.nodeType === 3) handleTextNode(node);
        else walk(node, 0);
      }
    } catch (error) {
      state.error = String((error && error.message) || error);
      state.on = false;                                  // 自我禁用, 绝不影响客户端
      try { console.error("[text-replacer] 出错已自动停用:", error); } catch (e) { /* 忽略 */ }
    }
  }

  function schedule(node) {
    if (!state.on || state.error) return;
    pending.add(node);
    if (pending.size > 4000) pending.clear();            // 极端情况下宁可漏也不卡
    if (scheduled) return;
    scheduled = true;
    try { window.requestAnimationFrame(flush); } catch (error) { flush(); }
  }

  const observed = new WeakSet();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") schedule(record.target);
      else for (const node of record.addedNodes) schedule(node);
    }
  });

  function observe(root) {
    if (!root || observed.has(root)) return;
    try {
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      observed.add(root);
    } catch (error) { /* 观察失败不影响已处理的部分 */ }
  }

  // 新挂上来的 shadow root 也要被观察到(客户端大量使用组件)
  try {
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      try { observe(root); schedule(root); } catch (error) { /* 忽略 */ }
      return root;
    };
  } catch (error) { /* 忽略 */ }

  observe(document.documentElement);
  walk(document.body || document.documentElement, 0);

  const controller = {
    get on() { return state.on; },
    off() { state.on = false; return "off"; },
    on_() { state.on = true; state.error = ""; walk(document.body || document.documentElement, 0); return "on"; },
    stats() { return { replaced: state.replaced, scanned: state.scanned, failed: state.failed, error: state.error, collected: collected.size }; },
    /** 导出"没翻译到"的中文清单(按出现次数无从统计, 按长度排序)。 */
    dump() {
      const list = [...collected].sort();
      const text = JSON.stringify(list, null, 2);
      try { navigator.clipboard.writeText(text); } catch (error) { /* 忽略 */ }
      return list;
    },
    clear() { collected.clear(); saveCollection(); return "cleared"; },
    translate
  };
  return controller;
}
  const dict = {"护甲":"Armadura","攻击速度":"Velocidad de ataque","格挡":"Bloquear ","暴击几率":"Probabilidad de Impacto Crítico","暴击伤害":"Daño de Impacto Crítico","能量":"Energía","能量回复/5秒":"Regeneración de Energía/5 s.","经验值":"Experiencia","生命值":"Vida","生命回复/5秒":"Regeneración de Vida/5 s.","法术强度":"Poder de habilidad","移动速度":"Velocidad de Movimiento","法力":"Maná","法力回复/5秒":"Regeneración de Maná/5 s.","攻击力":"Daño de ataque","魔法抗性":"Resistencia mágica","闪避":"Esquivar","经验获取":"Experiencia adquirida","生命回复":"Regeneración de vida","生命偷取":"Robo de vida","法力回复":"Regeneración de maná","法术吸血":"Succión de hechizo","护甲于18级":"Armadura en nivel 18","护甲穿透":"Penetración de armadura","护甲穿透于18级":"Penetración de armadura en nivel 18","暴击几率于18级":"Probabilidad de Impacto Crítico en nivel 18","暴击伤害于18级":"Daño de Impacto Crítico en nivel 18","闪避于18级":"Esquivar en nivel 18","能量于18级":"Energía en nivel 18","能量回复于18级":"Regeneración de Energía en nivel 18","金/10秒":"Oro/10 s.","生命值于18级":"Vida en nivel 18","生命回复于18级":"Regeneración de Vida en nivel 18","法术强度于18级":"Poder de habilidad en nivel 18","法术穿透":"Penetración mágica","法术穿透于18级":"Penetración Mágica en nivel 18","移动速度于18级":"Velocidad de Movimiento en nivel 18","法力于18级":"Maná en nivel 18","法力回复于18级":"Regeneración de Maná en nivel 18","攻击力于18级":"Daño de Ataque en nivel 18","魔法抗性于18级":"Resistencia mágica en nivel 18","死亡时间":"Tiempo que has estado muerto","死亡时间于18级":"Tiempo que has estado muerto en nivel 18","攻击速度于18级":"Velocidad de Ataque en nivel 18","冷却缩减":"Reducción enfriamiento","冷却缩减于18级":"Reducción de Enfriamiento en nivel 18","穿甲":"Letalidad","穿甲于18级":"Letalidad en nivel 18","正在更新《英雄联盟》……":"Actualizando League of Legends...",";annie;安妮;黑暗之女;heianzhinv;huonv;火女;an;hazn;hn":";annie",";kayle;kaier;凯尔;tianshi;天使;审判;ke;ts;shenpan;spts":";kayle",";xerath;zelasi;泽拉斯;tesila;特斯拉;yuanguwuling;远古巫灵;zls;tsl;ygwl":";xerath",";shyvana;龙女;longnv;xiwana;希瓦娜;龙血武姬;longxuewuji;ln;xwn;lxwj":";shyvana",";ahri;ali;阿狸;huli;狐狸;九尾妖狐;jiuweiyaohu;hl;jwyh":";ahri",";graves;格雷福斯;geleifusi;法外狂徒;fawaikuangtu;nanqiang;男枪;nq;glfs;fwkt":";graves",";fizz;feizi;chaoxihailing;菲兹;潮汐海灵;xiaoyuren;小鱼人;fz;cxhl;xyr":";fizz",";volibear;gouxiong;狗熊;wolibeier;沃利贝尔;不灭狂雷;bumiekuanglei;gx;wlbe;bmkl":";volibear",";rengar;shizigou;狮子狗;leienjiaer;雷恩加尔;aozhizhuiliezhe;傲之追猎者;szg;leje;azzlz":";rengar",";master yi;yidashi;易大师;jiansheng;剑圣;wuji;无极;yds;js;wjjs;yi":";maestro yi",";varus;weilusi;韦鲁斯;chengjiezhijian;惩戒之箭;wls;cjzj":";varus",";nautilus;taitan;泰坦;nuotilesi;诺提勒斯;shenhai;深海;ntls;sstt;tt":";nautilus",";viktor;weiketuo;维克托;jixiexianqu;机械先驱;三只手;sanzhishou;szs;wkt;jxxq;aoshuxianqu;asxq;奥术先驱":";viktor",";sejuani;zhunv;zhumei;猪女;猪妹;sezhuangni;瑟庄妮;beidizhinu;北地之怒;szn;zn;zm;bdzn":";sejuani",";fiora;剑姬;jianji;feiaona;菲奥娜;wushuang;无双;fan;fon;jj;wsjj":";fiora",";ziggs;zhadanren;炸弹人;吉格斯;jigesi;guicai;鬼才;baopo;爆破;jgs;bpgc;gc;zdr":";ziggs",";lulu;璐璐;露露;仙灵女巫;xianlingnvwu;ll;xlnw":";lulu",";draven;德莱文;delaiwen;文森特;wensente;rongyaoxingxingguan;荣耀行刑官;dlw;wst;ryxxg":";draven",";alistar;niutou;牛头;alisita;阿利斯塔;nt;alst":";alistar",";hecarim;hekalimu;赫卡里姆;renma;人马;zhanzhengzhiying;战争之影;hklm;rm;zzzy":";hecarim",";kha'zix;tanglang;螳螂;kazike;卡兹克;xukong;虚空;tl;kzk;xk":";kha'zix",";darius;delaiesi;德莱厄斯;nuoshou;诺手;dles;ns;诺克萨斯之手;nuokesasizhishou;nksszs":";darius",";jayce;jiesi;杰斯;weilaishouhuzhe;未来守护者;js;wlshz":";jayce",";lissandra;bingnv;冰女;lisangzhuo;丽桑卓;bingshuangnvwu;冰霜女巫;bn;lsz;bsnw":";lissandra",";ryze;faker;liulang;流浪;瑞兹;ruizi;fuwenfashi;符文法师;guangtou;光头;rz;ll;fwfs;gt":";ryze",";diana;daianna;黛安娜;jiaoyue;皎月女神;戴安娜;dan;jyns;jy":";diana",";quinn;kuiyin;奎因;niaoren;鸟人;demaxiyazhiyi;德玛西亚之翼;ky;dmxyzy":";quinn",";syndra;qiunv;球女;xindela;辛德拉;anheiyuanshou;暗黑元首;qn;xdl;ahys":";syndra",";aurelion sol;龙王;奥瑞利安;索尔;zhuxing;longwang;铸星;aoruilian;arla;lw;zxlw":";aurelion sol",";sion;saien;赛恩;wanglingzhanshen;亡灵战神;se;wlzs":";sion",";凯隐;kaiyin;kayn;暗裔魔镰;anyimolian;yingliuzhilian;影流之镰;ky;ayml;ylzl":";kayn",";zoe;zuoyi;佐伊;muguangxingling;暮光星灵;zy;mgxl;":";zoe",";zyra;jiela;婕拉;jingjizhixing;荆棘之兴;jl;jjzx":";zyra",";kai'sa;kasha;xukong;虚空;卡莎;ks;xkzn":";kai'sa",";Seraphine;salefenni;geji;slfn;xlgj;gj;萨勒芬妮;星籁;歌姬;酸辣粉;suanlafen":";seraphine;serafine;sera",";qiyana;qyn;ysnh;yuansunvhuang;奇亚娜;元素女皇;圈子妈;quanzima":";qiyana;kiyana;qiya;",";sivir;xiweier;希维尔;lunzima;轮子妈;zhanzhengnvshen;战争女神;xwe;lzm;zzns":";sivir",";gnar;naer;纳尔;mishizhiya;迷失之牙;ne;mszy":";gnar",";zac;zhake;扎克;shenghuamoren;生化魔人;zk;shmr":";zac",";yasuo;kuaile;fengnan;快乐;风男;亚索;jianhao;剑豪;jifeng;疾风;ys;jfjh;klfn":";yasuo",";soraka;naima;奶妈;索拉卡;suolaka;slk;nm;星妈;xingma;xm":";soraka",";vel'koz;大眼;dayan;weikezi;维克兹;xukong;虚空;dy;wkz;xkzy":";vel'koz",";taliyah;taliya;塔利亚;塔莉垭;yanque;岩雀;tly;yq":";taliyah",";camille;青钢影;卡蜜尔;qinggangying;kamier;qgy;kme":";camille",";akshan;阿克尚;影哨;the Rogue Sentinel;aks;akeshang;yingshao;ys":";akshan;ashkan;aksan",";teemo;timo;提莫;tibaiwan;提百万;xunjiechihou;迅捷斥候;tm;xjch":";teemo",";tristana;xiaopao;小炮;paoniang;炮娘;崔丝塔娜;cuisitana;mailinpaoshou;麦林炮手;xp;cstn;mlps":";tristana",";warwick;langren;狼人;wolike;沃里克;祖安怒兽;zuan;wlk;lr;zans":";warwick",";olaf;aolafu;奥拉夫;kuangzhanshi;狂战士;alf;kzs":";olaf",";nunu;努努;xueren;雪人;xueyuanshuangzi;雪原双子;xr;xysz;nn":";nunu",";belveth;beierweisi;xukongnvhuang;brws;xknh;Void Empress;卑尔维斯;虚空;女皇;虚空女皇;nvhuang;nh":";belveth;belvet;velvet;belbeth;belbet;velveth",";braum;bulong;布隆;fuleierzhuode;弗雷尔卓德;bl;flezd":";braum",";jhin;烬;戏命师;jin;wangyuan;望远;ximingshi;xms;wyj":";jhin",";kindred;qianjue;千珏;yonglieshuangzi;永猎双子;qj;ylsz":";kindred",";miss fortune;nvqiang;女枪;mf;eyunxiaojie;厄运小姐;haoyunjie;好运姐;shangjin;赏金;nq;eyxj;sj;hyj":";miss fortune",";ashe;aishe;爱射;aixi;艾希;hanbing;寒冰;as;ax;hb":";ashe",";zeli;zeri;zuanhuahuo;zahh;泽丽;zl;祖安花火":";zeri;ceri;cery;zery;neon",";jinx;jinkesi;金克丝;baozou;luoli;暴走;萝莉;jks;bzll;powder;baobao;bb;爆爆":";jinx",";tahm kench;hama;蛤蟆;tamu;塔姆;hm;tm;河流之王;hlzw;heliuzhiwang":";tahm kench",";tryndamere;manwang;蛮王;taidamier;泰达米尔;mw;tdme":";tryndamere",";briar;the Restrained Hunger;贝蕾亚;狂厄蔷薇;bly;keqw;beileiya;kuangeqiangwei":";briar",";viego;Ruined King;佛耶戈;破败之王;v哥;foyege;fyg;pobaizhiwang;pbzw;破败王;pobaiwang;pbw":";viego",";saina;senna;赛娜;dihunshengqiang;涤魂圣枪;sn;dhsq":";senna",";lucian;aobama;奥巴马;luxian;卢锡安;shengqiangyouxia;圣枪游侠;abm;lxa;sqyx":";lucian",";zed;jie;劫;yingliuzhizhu;影流之主;ylzz":";zed",";jax;jiakesi;贾克斯;wuqidashi;武器大师;jks;wqds;武器":";jax",";kled;克烈;暴怒骑士;kelie;baonuqishi;kl;bnqs":";kled",";ekko;aike;艾克;时间刺客;shijiancike;ak;sjck":";ekko",";morgana;moganna;莫甘娜;duoluotianshi;堕落天使;mgn;dlts":";morgana",";vi;wei;蔚;pichengzhifaguan;皮城执法官;pczfg;violet;蔚奥莱;weiaolai;wal;楚雨荨;chuyuxun;cyx":";vi",";zilean;shiguang;laotou;时光;老头;jilan;基兰;sg;jl":";zilean",";aatrox;yatuokesi;亚托克斯;jianmo;剑魔;anyi;暗裔;ytks;jm;ayjm":";aatrox",";nami;namei;娜美;huanchaojiaoji;唤潮鲛姬;nm;hcjj":";nami",";azir;shahuang;沙皇;azier;阿兹尔;shamohuangdi;沙漠皇帝;sh;aze;smhd":";azir",";singed;lianjin;炼金;xinjide;辛吉德;lj;xjd":";singed",";evelynn;guafu;寡妇;yifulin;伊芙琳;tongkuzhiyong;痛苦之拥;gf;yfl;tkzy":";evelynn",";twitch;laoshu;老鼠;tuqi;图奇;wenyizhiyuan;瘟疫之源;ls;tq;wyzy":";twitch",";galio;jialiao;加里奥;zhengyijuxiang;正义巨像;jla;jlo;zyjx":";galio",";karthus;sige;死歌;kaersasi;卡尔萨斯;sg;kess":";karthus",";cho'gath;kejiasi;科加斯;dachongzi;大虫子;xukong;虚空恐惧;kjs;dcz;xkkj":";cho'gath",";amumu;阿木木;munaiyi;木乃伊;amm;mny":";amumu",";rammus;longgui;wangba;龙龟;王八;lamosi;拉莫斯;lms;lg;wb":";rammus",";anivia;bingniao;冰鸟;fenghuang;凤凰;ainiweiya;艾尼维亚;bn;fh;anwy":";anivia",";shaco;xiaochou;小丑;sake;萨科;xc;sk":";shaco",";youmi;yuumi;maomi;cat;mfmm;魔法猫咪;猫咪;魔法;悠米;ym;mm":";yuumi;yumi;gata;gato;libro",";dr. mundo;mengduo;蒙多;zuan;祖安狂人;md;zakr":";dr. mundo",";samira;沙漠玫瑰;莎弥拉;shamila;desert rose;samila;shamomeigui;萨米拉;sml;smmg":";samira",";sona;qinnv;琴女;suona;娑娜;qinsexiannv;琴瑟仙女;sn;qn;qsxn":";sona",";kassadin;kasading;卡萨丁;xukong;虚空行者;xkxz;xukongxingzhe;ksd":";kassadin",";irelia;daomei;刀妹;airuiliya;艾瑞丽娅;daofengwuzhe;刀锋舞者;dm;arly;dfwz;女刀;nd;nvdao":";irelia",";twisted fate;tf;kapai;卡牌大师;cuisite;崔斯特;kp;kpds;kapaidashi;cst":";twisted fate",";janna;998;fengnv;风女;jiana;迦娜;fengbaozhinu;风暴之怒;fn;jn;fbzn":";janna",";gangplank;chuanzhang;船长;pulangke;普朗克;haiyangzhizai;海洋之灾;cz;plk;hyzz":";gangplank",";thresh;chuishi;锤石;hunsuodianyuzhang;魂锁典狱长;cs;hsdyz":";thresh",";corki;feiji;飞机;kuqi;库奇;yingyongtoudanshou;英勇投弹手;fj;kq;yytds":";corki",";illaoi;eluoyi;俄洛伊;haishoujisi;海兽祭司;chushouma;触手妈;大妈;dama;ely;hsjs;csm;dm":";illaoi",";rek'sai;leikesai;雷克塞;挖掘机;wajueji;xukongdundishou;虚空;lks;wjj;xkdds":";rek'sai",";ivern;艾翁;翠神;aiweng;cuishen;xiaoju;小菊;aw;cs;xj;xiaoshu;xs;小树":";ivern",";kalista;huabanxie;滑板鞋;kalisita;卡莉丝塔;fuchouzhimao;复仇之矛;hbx;klst;fczm":";kalista",";karma;shanzima;扇子妈;kaerma;卡尔玛;tianqizhe;天启者;kem;szm;tqz":";karma",";bard;bade;巴德;yinyoushiren;吟游诗人;xingjieyoushen;星界游神;bd;yysr;xjys":";bardo",";taric;baoshi;宝石;talike;塔里克;waluolanzhidun;瓦洛兰之盾;tlk;bs;wllzd":";taric",";veigar;weijia;维迦;xieexiaofashi;邪恶小法师;wj;xiaofashi;小法师;xfs;xexfs;小法":";veigar",";trundle;jumo;巨魔;telangdeer;特朗德尔;tlde;jm":";trundle",";rakan;洛;幻翎;luo;huanling;fenghuangchuanqi;凤凰传奇;hl;fhcq":";rakan",";xayah;霞;逆羽;xia;niyu;fenghuangchuanqi;凤凰传奇;fhcq;ny":";xayah",";xin zhao;zhaoxin;赵信;xinye;信爷;zx;xy;debangzongguan;德邦总管;dbzg":";xin zhao",";swain;wuya;乌鸦;siweiyin;斯维因;nuokesasitongling;诺克萨斯统领;wy;swy;nksstl":";swain",";caitlyn;nvjing;女警;kaitelin;凯特琳;picheng;皮城;nj;ktl;pcnj;cupcake;xiaodangao;xdg;小蛋糕":";caitlyn",";ornn;奥恩;山隐之焰;aoen;shanyinzhiyan;ae;syzy;yang;羊":";ornn",";解脱者;sailasi;sls;jtz;jietuozhe;sylas;Unshackled;塞拉斯":";sylas;silas;sailas",";nikou;neeko;wanhua;whtl;nk;妮蔻;万花通灵":";neeko;neko;niko",";efeiliusi;aphelios;the Weapon of Faith;canyuezhisu;厄斐琉斯;残月之肃;无E烦;wuefan;wuyifan;月男;yuenan;efls;cyzs;yn;wyf":";aphelios;afelios;alune",";rell;ruier;芮尔;铁女;Iron Maiden;镕铁少女;re;rongtieshaonv;rtsn;tienv;tn;mamei;mm;马妹":";rell;metal;ferromancia;rel",";blitzcrank;jiqiren;机器人;bulici;布里茨;jqr;blc;zhengqi;蒸汽;zqjqr":";blitzcrank",";malphite;shitouren;石头人;mofeite;墨菲特;rongyanjushou;熔岩巨兽;str;mft;ryjs;ry":";malphite",";katarina;katelinna;卡特琳娜;buxiangzhiren;不祥之刃;卡特;kate;ktln;kt;bxzr":";katarina",";pyke;paike;派克;xuegangguiying;血港鬼影;pk;xggy":";pyke",";nocturne;mengyan;梦魇;moteng;魔腾;my;mt;夜曲;yequ;yq":";nocturne",";maokai;茂凯;dashu;大树;niuqushujing;扭曲树精;mk;ds;nqsj":";maokai",";renekton;eyu;鳄鱼;leikedun;雷克顿;huangmotufu;荒漠屠夫;lkd;hmtf":";renekton",";jarvan iv;huangzi;皇子;jiawensishi;嘉文四世;hz;jwss;dmxyhz;demaxiyahuangzi;德玛西亚皇子":";jarvan iv",";urgot;pangxie;螃蟹;ejiate;厄加特;wuweizhanche;无畏战车;ejt;dpx;px;大螃蟹;wwzc":";urgot",";elise;zhizhu;蜘蛛;yilisi;伊莉丝;zznh;女皇;yls":";elise",";orianna;fatiao;发条;aolianna;奥莉安娜;ft;alan;魔灵;ftml":";orianna",";wukong;悟空;houzi;猴子;qitiandasheng;齐天大圣;孙悟空;swk;wk;hz;qtds;sunwukong":";wukong",";brand;huonan;火男;bulande;布兰德;fuchouyanhun;复仇焰魂;bld;hn;fcyh":";brand",";lee sin;xiazi;盲僧;瞎子;mangseng;liqing;李青;xz;ms;lq":";lee sin",";vayne;uzi;weien;薇恩;anyelieshou;暗夜猎手;we;ayls":";vayne",";rumble;lanbo;兰博;jixiegongdi;机械公敌;lb;jxgd":";rumble",";cassiopeia;shenv;蛇女;kaxiaopeiya;卡西奥佩娅;moshezhiyong;魔蛇之拥;sn;kxopy;mszy":";cassiopeia",";leblanc;yaoji;妖姬;lefulan;乐芙兰;yj;lfl;诡术妖姬;guishu;gsyj":";leblanc",";vex;gloomist;薇古丝;愁云使者;vgs;cysz;wgs;weigusi;veigusi;chouyunshizhe;aybb;aoyebobi;熬夜波比":";vex;emo;mcr",";skarner;xiezi;蝎子;sikana;斯卡纳;shanggulingzhu;上古领主;xz;skn;sglz":";skarner",";heimerdinger;datou;大头;dafamingjia;大发明家;heimodingge;黑默丁格;dt;dmmj;hmdg;famingjia;fmj;发明家":";heimerdinger",";nasus;goutou;狗头;neisesi;内瑟斯;shamosishen;沙漠死神;nss;gt;smss":";nasus",";nidalee;naidali;奶大力;baonv;豹女;naideli;奈德丽;kuangyenvlieshou;狂野女猎手;ndl;bn;kynls":";nidalee",";udyr;wudier;乌迪尔;shoulingxingzhe;兽灵行者;ud;wde;slxz;xiaoyan;xy;萧炎;野区萧炎;yequxiaoyan;yqxy":";udyr",";yone;永恩;封魔剑魂;yongen;fengmojianhun;fmjh;ye":";yone",";poppy;bobi;波比;圣锤之毅;shengchuizhiyi;bb;sczy":";poppy",";gragas;jiutong;酒桶;gulajiasi;古拉加斯;gljs;jt":";gragas",";ambessa;anbeisa;tiexielangmu;tiexuelangmu;txlm;abs;安蓓萨;铁血狼母;狼母;langmu;lm":";ambessa",";vladimir;xixuegui;吸血鬼;fulajimier;弗拉基米尔;xinghongshougezhe;猩红收割者;xxg;fljme;xhsgz":";vladimir",";pantheon;pansen;潘森;sibada;斯巴达;buquzhiqiang;不屈之枪;ps;bqzq":";pantheon",";mel;jingyingliuguang;meier;梅尔;me;镜影流光;jylg;流光镜影;liuguangjingying;lgjy":";mel",";yunana;芸阿娜;不破之誓;the Unbroken Faith;yan;yunara;bupozhishi;bpzs":";yunara",";locke;灰烬驱魔人;洛克;the Ashen Exorcist;hjqmr;huijinqumoren;luoke;lk":";locke",";ezreal;ez;yize;伊泽;tanxianjia;探险家;yz;txj;yizeruier;伊泽瑞尔;yzre":";ezreal",";mordekaiser;tienan;铁男;modekaisa;莫德凯撒;tiekaiminghun;铁铠冥魂;mdks;jsds;jinshudashi;金属大师;modeganqing;莫得感情;tn;mdgq;tkmh":";mordekaiser",";yorick;yuelike;约里克;juemu;掘墓;muhunren;牧魂人;ylk;jm;mhr":";yorick",";akali;阿卡丽;liqunzhici;离群之刺;akl;lqzc":";akali",";kennen;kainan;凯南;dianhaozi;电耗子;kuangbaozhixin;狂暴之心;kn;kbzx":";kennen",";garen;gailun;盖伦;德玛西亚之力;demaxiyazhili;gl;dmxyzl":";garen",";seti;sett;the Boss;瑟提;st;腕豪;wh;wanhao;男拳;nanquan;nq":";sett",";莉莉娅;liliya;hxbl;hanxiubeilei;lillia;含羞;蓓蕾;妮马;蔻马;nima;kouma;鹿女;lunv;梦鹿;menglu;beilei;lly":";lillia;lilia;caballo;ciervo;cervatilla",";gwen;gewen;the Hallowed Seamstress;灵罗娃娃;格温;gw;llww;lingluowawa;剪子妈;jianzima;jzm;剪妹;jianmei;jm;一剪没;yijianmei;yjm;滚;gun":";gwen;guen;wen",";lienata;lnt;lianjinnanjue;ljnj;renata;chemtech;baroness;烈娜塔;炼金男爵;glsk;gelasike;戈拉斯克;glasc":";renata glasc;renata;glasc",";leona;nvtan;rinv;女坦;日女;leiouna;蕾欧娜;shuguangnvshen;曙光女神;lon;rn;nt;sgns":";leona",";阿萝拉;aluola;aurora;双界灵兔;shuangjielingtu;sjlt;all;兔女;tunv;tn;tuzi;tz;兔子":";aurora",";nila;nilah;the Joy Unbound;尼菈;nl;不羁之悦;bujizhiyue;bjzy":";nilah",";k'sante;kuisangti;kst;nazumangrongyao;nzmry;奎桑提;纳祖芒荣耀":";k'sante",";fiddlesticks;daocaoren;稻草人;feidetike;费德提克;yuangukongju;远古恐惧;dcr;fdtk;ygkj":";fiddlesticks",";malzahar;mazha;蚂蚱;maerzhaha;玛尔扎哈;xukongxingzhe;虚空先知;mezh;mz;xkxz":";malzahar",";simode;smolder;youlong;long;chiyan;chulong;chiyanchulong;炽;龙;炽炎雏龙;斯莫德;smd;cycl;yl;幼龙;xiaolongren;xlr;小龙人;小火龙;xiaohuolong;xhl;mabaolong;mbl;妈宝龙":";smolder",";milio;the gentle flame;mingzhu;miliou;mlo;mz;米利欧;明烛":";milio",";zaahen;The Unsundered;不落魔锋;亚恒;yaheng;buluomofeng;yh;blmf":";zaahen",";talon;nandao;男刀;tailong;泰隆;daofengzhiying;刀锋之影;tl;nd;df":";talon",";hwei;彗;hui;yihuashi;the Visionary;huajia;画家;异画师;yhs;hj;maobiren;mbr;毛笔人":";hwei",";riven;ruiwen;锐雯;fangzhuzhiren;放逐之刃;rw;fzzr":";riven",";naafiri;the Hound of a Hundred Bites;纳亚菲利;百裂冥犬;nayafeili;nyfl;bailiemingquan;blmq;gou;狗;dog":";naafiri",";kog'maw;dazui;大嘴;kegemo;克格莫;shenyuanjukou;深渊巨口;kgm;dz;shenyuanjukou;syjk":";kog'maw",";shen;慎;muguangzhiyan;暮光之眼;yaozi;腰子;mgzy;yz":";shen",";lux;lakesi;拉克丝;guanghuinvlang;光辉女郎;lks;ghnl":";lux","见习刺客":"Maleante","初级刺客":"Sicario","中级刺客":"Impío","高级刺客":"Degollador","杀戮之影":"Verdugo","杀戮宗师":"Exterminador","死神":"Señor de la muerte","见习战士":"Púgil","初级战士":"Camorrista","中级战士":"Guerrero","高级战士":"Veterano","征服之刃":"Destructor","征服宗师":"Belicista","战神":"Señor de la guerra","见习法师":"Iniciado","初级法师":"Adepto","中级法师":"Conjurador","高级法师":"Magus","织法之杖":"Brujo","织法宗师":"Hechicero","法神":"Archimago","见习射手":"Rastreador","初级射手":"Explorador","中级射手":"Cazador","高级射手":"Montaraz","鹰隼之眼":"Fusilero","射击宗师":"Francotirador","狙神":"Tirador","见习辅助":"Ayudante","初级辅助":"Protector","中级辅助":"Custodio","高级辅助":"Defensor","庇护之光":"Protector","庇护宗师":"Centinela","守护之神":"Guardián","见习坦克":"Bruto","初级坦克":"Gorila","中级坦克":"Mole","高级坦克":"Bastión","无畏之盾":"Baluarte","无畏宗师":"Coloso","巨神":"Titán","登录失败，请重试。":"Combinación errónea de nombre de usuario y contraseña. Inténtalo de nuevo.","一个意料之外的错误发生了":"Se ha producido un error inesperado.","所有角色定位":"Todas las posiciones","刺客":"Asesino","战士":"Luchador","法师":"Mago","射手":"Tirador","辅助":"Apoyo","坦克":"Tanque","错误代码":"Código de error","我们无法加载这个页面。如果你的互联网连接没问题的话，请稍等几分钟然后重试。":"No hemos podido cargar esta página. Si tu conexión a internet funciona correctamente, espera unos minutos e inténtalo de nuevo","重试":"Volver a intentar","{{feature}}目前已被禁用":"{{feature}} está actualmente desactivado/a.","这个功能目前已被禁用":"Esta opción está desactivada actualmente.","暂未实装":"Todavía no se ha implementado","创建房间":"CREAR SALA","退出":"SALIR","对水晶之痕的简短描述。":"Una breve descripción de la Cicatriz de Cristal.","和随机选择英雄的队友一起，去摧毁敌人的水晶枢纽。":"Lucha en un equipo de cinco campeones elegidos al azar para atacar el puente y capturar el nexo enemigo.","正义之地最古老最威严的战场当属召唤师峡谷。几百年间无数对立的召唤师们在这片战场上延续着战斗，这片战场也因此而得名。有三条不同的道路穿越整个战场。与友军一起攻击敌人最脆弱的地方，摧毁他们的基地！":"El Campo de la Justicia más antiguo y venerable se conoce como la Grieta del Invocador. La Grieta se ubica en un bosque remoto entre Freljord, el río Serpentino y las Montañas Puntahierro.","对扭曲丛林的简短描述。":"Una breve descripción del Bosque Retorcido.","水晶之痕":"Cicatriz de Cristal","水晶\n之痕":"CICATRIZ\nDE CRISTAL","已被禁用，并在维修中。我们对此带来的不便深表歉意。":"se ha desactivado para realizar tareas de mantenimiento. Sentimos todos los inconvenientes que esto pueda causar.","嚎哭深渊":"Abismo de los Lamentos","嚎哭\n深渊":"ABISMO\nDE LOS LAMENTOS","召唤师峡谷":"Grieta del Invocador","召唤师\n峡谷":"GRIETA DEL\nINVOCADOR","扭曲丛林":"Bosque Retorcido","扭曲\n丛林":"BOSQUE\nRETORCIDO","创建自定义游戏":"Crear personalizada","这个模式目前已被禁用":"Este modo está deshabilitado actualmente.","加入自定义游戏":"Unirse a personalizada","匹配模式":"Normal","排位赛":"Clasificatorias","新手教程":"Tutorial","人机":"Cooperativa vs. IA","极地大乱斗":"ARAM","全随机（极地大乱斗）1v1":"Todos aleatorio (ARAM) 1v1","全随机（极地大乱斗）2v2":"Todos aleatorio (ARAM) 2v2","全随机（极地大乱斗）3v3":"Todos aleatorio (ARAM) 3v3","全随机（极地大乱斗）5v5":"Todos aleatorio (ARAM) 5v5","全随机（极地大乱斗）6v6":"Todos aleatorio (ARAM) 6v6","全随机人机对战（极地大乱斗）5v5":"Todo aleatorio vs. IA (ARAM) 5v5","统治战场5v5":"Dominion 5v5","极地大乱斗5v5":"ARAM 5v5","经典模式5v5":"Clásica 5v5","经典模式3v3":"Clásica 3v3","全随机（大乱斗）":"TODO ALEATORIO (ARAM)","内部服务器错误，请稍后重试":"Error interno del servidor. Inténtalo de nuevo más tarde.","你已经与新闻服务断开了连接。请手动重新连接。":"Has sido desconectado del servicio de noticias. Por favor, conéctate de nuevo manualmente.","经常使用":"Jugado con frecuencia","确认":"Aceptar","是":"Sí","否":"No","接受":"ACEPTAR","拒绝":"RECHAZAR","最终用户许可协议":"ACUERDO DE LICENCIA DE USUARIO FINAL","使用条款":"TÉRMINOS DE USO","取消":"Cancelar","授予邀请":"Conceder invitaciones","移出玩家":"Expulsar","提升为队长":"Ascender a capitán","撤回邀请":"Revocar invitaciones","通过拖动来邀请玩家。":"Arrastra para invitar.","寻找对局":"ENCONTRAR PARTIDA","阻塞":"Bloqueado","邀请":"Invitar","添加":"Añadir","邀请玩家":"Invitar jugadores","发送邀请":"Enviar invitaciones","输入玩家名称":"Introduce el nombre del jugador","已邀请":"Invitado","你真的想移出{{summonerName}}吗？":"¿Seguro que quieres expulsar a {{summonerName}}?","你已被移出了组房间":"Te han expulsado de la sala de la partida.","与你的好友一起玩，你就会获得组队奖励！更多好友组队意味着更多战利品，所以快去组队吧！":"¡Si juegas con tus amigos puedes ganar Recompensas en grupo! Cuantos más jugadores, más botín, ¡así que anímate!","组队奖励":"RECOMPENSAS DE GRUPO","与你的好友一起玩来获得蓝色精萃奖励！更多好友组队意味着更多战利品！":"Consigue recompensas de PI al jugar con amigos. ¡A más amigos, más botín!","快组队吧！":"¡HAZ UN EQUIPO!","待定":"Pendiente","已推荐":"Sugeridos","<span class='click-instruction'>点击以添加{{pointsAssignedOnClick}}点。</span><span class='click-instruction'>按住SHIFT键点击以添加1点。</span>":"<span class='click-instruction'>Haz clic para añadir {{pointsAssignedOnClick}} puntos.</span><span class='click-instruction'>Pulsa Mayús y haz clic para añadir un punto.</span>","<span class='click-instruction'>点击以添加1点。</span>":"<span class='click-instruction'>Haz clic para añadir un punto.</span>","下个点数":"Siguiente punto","无法在服务器上创建一个天赋页。也许是因为连接问题。":"No se ha podido crear la página de maestrías en el servidor. Puede que se trate de un error de conexión.","添加新的天赋页":"Añadir una página nueva","天赋页{{number}}":"Pág. de maestrías {{number}}","你确定想要删除该页吗？":"¿Seguro que quieres borrar esta página?","删除天赋页":"Eliminar página","编辑天赋页名称":"Editar nombre de la página","可用点数：{{number}}":"Puntos disponibles: {{number}}","重置此天赋页的点数":"Devolver puntos de la página","重置此天赋树的点数":"Devolver puntos de este árbol","点击这里来保存你对天赋页的所有改动。":"Haz clic para guardar todos los cambios en tus páginas de maestrías.","由于连接失败，无法保存天赋页面。":"No se han podido guardar las páginas de maestrías debido a un error de conexión.","保存":"GUARDAR","你的天赋有尚未保存的改动。你想要保存吗？":"Hay cambios sin guardar en tus maestrías. ¿Quieres guardar?","需要在<span class='mastery-type'>{{type}}</span>至少分配{{ranks}}点":"Hacen falta {{ranks}} puntos en <span class='mastery-type'>{{type}}</span>","需要在{{prereq}}至少分配{{ranks}}点":"Se necesitan {{ranks}} niveles en {{prereq}}.","剩余{{pointsLeft}}点数":"Quedan {{pointsLeft}} puntos","诡诈":"ASTUCIA","凶猛":"FEROCIDAD","坚决":"VALOR","诡诈系":"Astucia","凶猛系":"Ferocidad","坚决系":"Valor","房间":"Grupo","藏品":"Colección","冠军杯赛":"Clash","电竞":"Esports","主页":"Inicio","经典模式":"Classic","战利品/圣堂":"Botín","新闻":"Noticias","云顶之弈":"TFT","幸运商店":"Tu tienda","生涯":"Perfil","商城":"Tienda","海斗第3季":"Set 3 de Caos","更多信息":"MÁS INFORMACIÓN","检测到必要更新":"Actualización necesaria detectada","你的网络连接出问题了。如果你目前还没有连接上互联网，请先连接互联网。如果你已经连上互联网了但无法连接上《英雄联盟》，请查阅我们的<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>客服信息</a>来看看是否有可行的解决方案。":"Hay un problema con tu conexión. Si no te has conectado ya a internet, hazlo ahora. Si te has conectado a internet pero no puedes acceder a League of Legends, echa un vistazo a nuestra <a href=\"https://support-leagueoflegends.riotgames.com/hc/es/articles/201752664\" target='_blank'>página de apoyo</a> para encontrar posibles soluciones.","好的":"Aceptar","我们复原了一个较旧版本的《英雄联盟》。现在我们将尝试把它更新为最新版本。":"Hemos restaurado una versión antigua de League of Legends. Ahora intentaremos actualizarla a la versión más reciente.","{{megabytes}} MB / {{kilobytes_per_second}} KB/秒":"{{megabytes}} MB @ {{kilobytes_per_second}} KBps","在你安装目录下的文件权限正在阻止《英雄联盟》的安装。请按“OK”键，然后我们将尝试唤起你的操作系统的权限管理器。":"Los permisos de archivo en el directorio de instalación impiden que League of Legends se instale. Haz clic en ''Aceptar'' e intentaremos cambiar los permisos de tu sistema operativo.","在连接至服务器时出问题了。请检查你的网络连接并重启补丁器。如果你的网络连接没有问题，请联系客服进行处理。":" Hay problemas para conectarse al servidor. Comprueba tu conexión a internet y reinicia el instalador. Si el problema no es tu conexión a internet, sigue los pasos de resolución de problemas de nuestra <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>página de soporte</a> para encontrar una posible solución.","补丁器无法下载内容至你的硬盘。请检查下你的电脑，至少需要8GB的空闲容量和写入硬盘的必要权限才能安装《英雄联盟》。你可以联系我们的客服来获取更多有关这个错误的帮助。*注意*：点击“是”将关闭客户端。":"No se ha podido descargar la versión a tu disco duro. Este error suele producirse por no tener suficiente espacio para la descarga en el disco duro. Asegúrate de que tu ordenador tiene 8 GB de espacio libre donde está instalado League of Legends y que cuentas con los permisos necesarios para escribir en el disco duro. Si necesitas más ayuda con este error, comprueba los pasos de resolución de problemas <a href=\"https://support-leagueoflegends.riotgames.com/hc/es/articles/202969434\" target='_blank'>aquí</a>. Nota: Hacer clic en ''Aceptar'' cerrará el cliente.","我们的服务器出故障了，并且在阻止你下载补丁内容。我们正在给服务器另一次机会。你可以<a href=\"http://lol.qq.com/act/a20150326dqpd/\" target='_blank'>点此</a>查看我们的服务器状态。":"Hay un problema con nuestros servidores que impide la actualización. Vamos a volver a intentarlo. Mientras tanto, puedes comprobar el estado de nuestros servidores <a href=\"http://status.leagueoflegends.com/?es_ES#euw\" target='_blank'>aquí</a>.","《英雄联盟》无法更新，因为你没有足够的硬盘空间。请至少释放{{Bytes}}空间然后重试。":"No se puede actualizar League of Legends porque no tienes suficiente espacio en disco. Libera al menos {{Bytes}} de espacio y vuelve a intentarlo.","补丁更新失败，并且我们不确定原因是什么。请重启客户端并重试补丁更新。":"La actualización ha fallado pero no sabemos el motivo. Reinicia el cliente para intentarlo de nuevo.","预计用时 {{number}}分钟":"Tiempo aproximado {{number}} min","好":"Aceptar","文件无法写入硬盘。请检查你是否有足够的磁盘空间和必要的许可。":"No se ha podido añadir el archivo al disco. Por favor, asegúrate de que tienes suficiente espacio en el disco y de que tienes los permisos necesarios.","已修复档案：{{number}}":"Archivos reparados: {{number}}","已扫描的文件：{{number}}":"Archivos analizados: {{number}}","联盟客户端":"CLIENTE DE LEAGUE","游戏客户端":"CLIENTE DEL JUEGO","我们的服务器发生了些状况，导致你无法从服务器中获得更新文件。我们正在对服务器进行停机维护。在维护时，你可以在这里查看我们的服务器状态。":"Hay un problema con nuestros servidores que impide la actualización. Vamos a volver a intentarlo. Mientras tanto, comprueba el estado de nuestros servidores desde aquí.","这个错误也许由以下现网内部事故导致：":"El error puede haber sido causado por los siguientes  motivos:","我们已经将这个安装程序恢复至一个较早的《英雄联盟》版本、现在我们将尝试将它更新至最新版本。":"Hemos restaurado esta instalación a una versión antigua de League of Legends. Ahora intentaremos actualizarla a la versión más reciente.","正在应用版本补丁":"Aplicando versiones","正在下载文件":"Descargando archivos...","正在提取所需的版本数据":"Obteniendo información necesaria sobre la versión","正在安装":"INSTALANDO","正在下载":"DESCARGANDO","正在修复":"REPARANDO","正在扫描":"ESCANEANDO","修复":"Reparar","抱歉！我们在你的安装过程中检测到一些数据损坏。你想要修复受损的文件么？":"¡Lo sentimos! Hemos detectado datos de instalación que pueden estar corruptos. ¿Quieres reparar los archivos afectados?","更新已完成下载。你必须重启客户端才能让更新生效。":"Se ha completado la descarga de una actualización. Es necesario reiniciar League of Legends para poder instalarla.","现在还不行":"Ahora no","重新启动":"Reiniciar","第{{current_step}}步（共{{total_steps}}步）":"Paso {{current_step}} de {{total_steps}}","更新失败，而我们不确定是什么原因。点击我们的客服页面{{support page}}来查找可能的解决方法。":"La actualización ha fallado, pero no sabemos por qué. Visita la página del servicio técnico {{support_page}} para encontrar posibles soluciones.","正在更新……":"Actualizando...","在更新《英雄联盟》时出现了一个问题。我们正在复原《英雄联盟》的备份版本，并会在你重新启动后再次尝试":"Se ha producido un error al actualizar League of Legends. Vamos a recuperar una versión anterior del juego y a volver a intentarlo tras el reinicio.","游戏仍在进行中…":"La partida sigue en curso...","全随机":"TODO ALEATORIO","跳过等待，直接开始下一局游戏。":"Saltarse las estadísticas","开始游戏":"Comenzar partida","可用":"Disponible","剩余1日":"1 día restante","剩余{{days}}天":"{{days}} días restantes","金币加成":"MEJORA DE PI","网吧特权加成":"Mejora de lealtad","下一个奖励的进度":"PRÓXIMA BONIFICACIÓN EN","下一次重随的进度":"PRÓXIMO CAMBIO","没有激活加成":"No hay mejoras activas","剩余1胜":"1 victoria restante","剩余{{wins}}胜场":"{{wins}} victorias restantes","双倍经验卡":"MEJORA DE EXP","记分板":"TABLA DE PUNTUACIONES","下一个":"Siguiente","失败":"DERROTA","第二名":"SEGUNDO PUESTO","第1名":"1.º","蓝色精萃":"EA","全员战斗加成蓝色精萃已获得":"MEJORA DE BATALLA: EA CONSEGUIDAS","蓝色精萃加成":"MEJORA DE EA","当天首次胜利":"PRIMERA VICTORIA DEL DÍA","蓝色精萃获取":"EA CONSEGUIDAS","特权加成蓝色精萃已获取":"MEJORA DE LEALTAD: EA CONSEGUIDAS","统治战场蓝色精萃加成":"EA POR BONIFICACIÓN DE ODÍN","小队奖励蓝色精萃加成已获得":"RECOMPENSA DE JUEGO EN GRUPO: EA ADICIONALES CONSEGUIDAS","排队加成已获取":"BONIFICACIÓN DE COLA OBTENIDA","逃兵":"ABANDONO","等级":"NIVEL","此负场不作记录":"DERROTA EVITADA","加成点数":"Puntos de bonificación","点数获取":"Puntos ganados","总计：":"Total:","胜利":"VICTORIA","点数":"PUNTOS","总经验":"EXP EN TOTAL","特权加成经验已获取":"EXP OBTENIDOS POR MEJORA DE LEALTAD","经验已获取":"EXP GANADOS","还需{{points}}点即可到达{{level}}级":"{{points}} puntos para llegar a nivel {{level}}","重新连接":"Reconectar","游戏已经结束。你现在将返回主页。":"La partida ha finalizado. Ahora volverás a la página principal.","您中途退出游戏，\n请重新连接。":"Has abandonado una partida en curso. Vuelve a conectarte a la partida.","添加好友":"Añadir amigo","首页":"INICIO","再玩一次":"VOLVER A JUGAR","审核用的举报已经发送。感谢您的反馈。":"Se ha enviado un informe que será revisado. Gracias.","你已经用完了所有可用的奖励。":"Has agotado la cuota de kudos.","确定":"Aceptar","北":"Norte","队伍2":"EQUIPO 2","南":"Sur","队伍1":"EQUIPO 1","查看高级详情":"VER DETALLES AVANZADOS","附加评论":"Comentarios adicionales","给敌方放水":"Ayudar al enemigo","在这里输出评论":"Introduce tu comentario aquí","不当的用户名":"Nombre inadecuado","故意送人头":"Sacrificio intencionado","挂机":"Abandono/Inactividad","消极态度":"Actitud negativa","不与团队进行沟通":"Falta de comunicación con el equipo","攻击性的语言":"Lenguaje ofensivo","举报":"INFORMAR","举报玩家":"Informar sobre jugador","滥发信息":"Envío de “spam”","无法举报这个玩家。请稍后再试。":"No fue posible informar de este jugador. Inténtalo de nuevo más tarde.","玩家水平过低":"Jugador poco hábil","口头谩骂":"Abuso verbal","态度友好":"Amigable","乐于助人":"Amable","可敬的对手":"Rival honorable","无法称赞这个玩家。请稍后再试。":"No fue posible dar kudos a este jugador. Inténtalo de nuevo más tarde.","团队合作":"Juega en equipo","助攻":"Ayudas","英雄击杀":"Campeones asesinados","死亡":"Muertes","金币获取":"Oro ganado","小兵击杀":"Súbditos asesinados","该局总分":"Puntuación de la partida","召唤师等级：":"Nv. invocador:","加成":"MEJORA","你确定要从英雄选择阶段离开吗？":"¿Seguro que quieres salir de la selección de campeones?","一位玩家秒退了；你已经回到了房间。":"Un jugador ha evitado la partida. Se te ha devuelto a la página principal.","敌方队伍":"EQUIPO ENEMIGO","你有{{rerolls}}个可用的英雄重随机会。":"Dispones de {{rerolls}} repeticiones de selección de campeón.","这个召唤师技能已被禁用。":"Se ha deshabilitado el hechizo.","等级需求：{{level}}":"BLOQUEADO HASTA NIVEL {{level}}","{{actor}}正在和其他人交换":"{{actor}} está intercambiando con otra persona.","这个交换已被取消。":"Se ha cancelado el intercambio.","交换已被拒绝。":"Se ha rechazado el intercambio.","还不能发出交换请求。请重试。":"No se ha podido solicitar el intercambio. Inténtalo de nuevo.","{{actor}}想要用{{entity1}}交换{{entity2}}。":"{{actor}} quiere intercambiar a {{entity1}} por {{entity2}}.","用{{entity1}}交换{{entity2}}。":"Intercambiar a {{entity1}} por {{entity2}}.","正在等待{{actor}}回应你的交换请求……":"Esperando a que {{actor}} responda a tu solicitud de intercambio...","己方队伍":"TU EQUIPO","接受！":"¡Aceptar!","{{summonerName}}在英雄选择时离开。你已重新回到房间。":"{{summonerName}} ha abandonado durante la selección de campeón. Has sido devuelto a la sala de partida.","一名玩家在英雄选择时离开。你已重新回到房间。":"Un jugador ha abandonado durante la selección de campeón. Has sido devuelto a la cola.","对局已找到":"PARTIDA ENCONTRADA","准备战斗":"PREPÁRATE PARA EL COMBATE","对局已接受":"ENFRENTAMIENTO ACEPTADO","对局已拒绝":"ENFRENTAMIENTO RECHAZADO","正在等待其他玩家":"ESPERANDO A OTROS JUGADORES","符文页{{number}}":"Página de runas {{number}}","选择全部":"Seleccionar todo","都不选择":"No seleccionar nada","选择玩家来解除聊天黑名单，然后点击保存。":"Selecciona a los jugadores que quieras desbloquear y guarda los cambios.","按字母顺序排列":"Alfabético","开启语言过滤器":"Activar filtro de lenguaje soez","启动链接警告":"Activar avisos de enlaces","在线状态":"Estado en línea","好友列表的排列顺序：":"Ordenar lista de amigos por:","启动菜单动画":"Activar animaciones del menú","启动警告弹窗":"Activar ventanas emergentes de notificación","聊天黑名单":"Lista de bloqueados","聊天&好友":"Chat y amigos","恢复默认设置":"Predeterminadas","你确定要将所有选项重置为默认设置吗？":"¿Seguro que quieres restablecer los valores predeterminados de todos los ajustes?","综合":"General","键位绑定":"Teclas de acceso rápido","选项":"Opciones","全部恢复默认设置":"Restablecer todos los valores predeterminados","声音":"Sonidos","如果你的《英雄联盟》出了什么毛病，就点击下方的修复按钮来搞定它吧！警告：这个操作会耗费很长一段时间。":"Si algo no funciona bien en League of Legends, haz clic en el botón de reparar, más abajo, para arreglarlo. Ojo, llevará bastante tiempo.","你真的想要修复吗？它会耗费很长一段时间！":"¿Seguro que quieres reparar? ¡Llevará un buen rato!","英雄选择界面的音乐音量":"Volumen de música en selección de campeones","启动英雄选择界面的音乐":"Activar música en selección de campeones","启动登陆音乐":"Activar música de inicio de sesión","启动音效":"Activar efectos de sonido","音效音量":"Volumen de efectos de sonido","关闭登录动画":"Deshabilitar animaciones de inicio de sesión","关闭登录音效":"Desactivar música de inicio de sesión","选择":"Seleccionar","传说之证 边框":"Borde de prestigio","排位边框":"Borde de clasificatoria","展示往届排位旗帜":"Mostrar estandarte de clasificatoria anterior","无法保存。请稍后重试。":"No se ha podido guardar. Inténtalo de nuevo más tarde","已选择":"Seleccionado:","当前不可用。":"No está disponible en este momento.","进行排位赛以解锁！":"¡Desbloquea bordes jugando clasificatorias!","保存中":"Guardando","选择一个召唤师图标":"Elige un icono de invocador","召唤师图标&边框选择器":"Selector de icono de invocador y borde","无法保存你的选择。":"Error al guardar la selección.","屏障":"Barrera","为你的英雄套上护盾，吸收115-455（取决于英雄等级）点伤害，持续2秒。":"Protege a tu campeón, absorbiendo 115-455 de daño (según el nivel del campeón) durante 2 segundos.","洞察":"Clarividente","将地图上任意一块区域暴露给你的队伍，持续5秒。":"Muestra a tu equipo una pequeña zona del mapa durante 5 segundos.","清晰术":"Claridad","为你的英雄回复40%的最大法力值。也会为友军回复他们40%的最大法力值":"Restaura el 40% del maná máximo a tu campeón. También restaura a los aliados el 40% de su maná máximo.","净化":"Limpiar","移除身上的所有限制效果和召唤师技能的减益效果，并且若在接下来的3秒里再次被施加限制效果时，新效果的持续时间会减少65%。":"Elimina todas las inhabilitaciones y efectos de hechizos de invocador que afectan al campeón y reduce en un 65% la duración de las debilitaciones recibidas durante 3 segundos.","虚弱":"Extenuación","虚弱目标敌方英雄，降低目标英雄30%的移动速度和攻击速度，以及10护甲与魔法抗性，并且他们所造成的伤害减少40%，持续2.5秒。":"Extenúa al campeón enemigo objetivo, reduciéndole un 30% de su Velocidad de Movimiento y Velocidad de Ataque, la Armadura y la Resistencia Mágica por 10 y un 40% de su capacidad total de daño durante 2,5 segundos.","闪现":"Destello","使英雄朝着你的指针所停的区域瞬间传送一小段距离。":"Teleporta a tu campeón una corta distancia hacia la posición del cursor.","卫戍部队":"Guarnición","友方防御塔：提供巨量回复，持续8秒。敌方防御塔：降低伤害输出，持续8秒":"Torreta aliada: concede una gran regeneración durante 8 segundos. Torreta enemiga: reduce el daño infligido en un 80% durante 8 segundos.","幽灵疾步":"Fantasmal","你的英雄在移动时会无视单位的碰撞体积，移动速度增加27%，持续10秒。":"Tu campeón puede moverse entre unidades y tiene un 27% más de velocidad de movimiento durante 10 segundos.","治疗术":"Curar","为你和目标友军英雄回复95-345（取决于英雄等级）生命值，并为你和目标友军英雄提供30%移动速度加成，持续1秒。若目标近期已受到过其它治疗术的影响，则治疗术对目标产生的治疗效果减半。":"Restaura 90-345 de Vida (según el nivel del campeón) y otorga un 30% de Velocidad de Movimiento adicional durante 1 segundo tanto a ti como al campeón aliado seleccionado. El efecto de curación se reduce a la mitad en el caso de unidades afectadas hace poco por Curar.","引燃":"Prender","引燃是对单体敌方目标施放的持续性伤害技能，在5秒的持续时间里造成70-410（取决于英雄等级）真实伤害，获得目标的视野，并减少目标所受的治疗和回复效果。":"Hace arder a un campeón enemigo durante 5 s, infligiéndole 70-410 (según el nivel del campeón) de daño verdadero, garantiza la visión del objetivo y reduce los efectos de curación que este reciba.","标记":"Marca","沿直线扔出一个雪球。如果雪球命中了一个敌人，那么这个敌人会被【标记】，并且你的英雄接下来可以快速突进到被【标记】的目标旁边。":"Lanza una bola de nieve en línea recta hacia tus enemigos. Si alcanzas a uno queda marcado y a continuación tu campeón puede desplazarse con rapidez hasta él.","魄罗投掷":"Porolanzamiento","把一个魄罗投向你的敌人。如果它命中了一名敌人，那么你接下来就可以快速位移到被命中的敌人旁边。":"Lanza un poro a los enemigos. Si aciertas, a continuación puedes viajar rápidamente al objetivo.","重生":"Reanimación","立刻在本队的召唤师平台上复活你的英雄，并暂时提升英雄的移动速度。":"Revive instantáneamente a tu campeón en la plataforma de invocador de tu equipo y aumenta su Velocidad de Movimiento un breve periodo.","惩戒":"Aplastar","对目标史诗野怪、大型野怪或敌方小兵造成390-1000（取决于英雄等级）点真实伤害。":"Causa entre 390 y 1000 de daño verdadero (dependiendo del nivel del campeón) a monstruos épicos o gigantes, o súbditos enemigos.","传送":"Teleportar","在引导3.5秒后，将英雄传送到目标友方建筑物、小兵或守卫旁边。":"Después de 3,5 segundos de preparación, teleporta a tu campeón al súbdito, estructura o guardián aliados que hayas escogido.","护驾！":"¡Al Rey!","快速位移到魄罗之王旁边。":"Te envía rápidamente al lado del Rey Poro.","立刻领取":"INSTANTÁNEO","免费":"GRATIS","设置数量":"Cantidad","你没有足够的代币。":"No tienes símbolos suficientes.","输入至少{{minQuantity}}个。":"Introduce un mínimo de {{minQuantity}}.","你只能以{{minQuantity}}的倍数来购买。":"Solo puedes comprar múltiplos de {{minQuantity}}.","愚人节快乐，乐子人们！来庆祝一下吧！ ":"¡Feliz April Fools, amante del cachondeo! ¡Vamos a celebrarlo!","愚人节大军需要增援，而你就是那个完美的呆萌士兵！":"El ejército del April Fools necesita refuerzos, ¡y no hay soldado más guasón que tú!","冲啊！我的无-羽-伦比的派对礼品就给你拿去用来对抗混乱大军吧。":"¡A la batalla! ¡En la fiesta habrá regalos pingutásticos que te ayudarán a luchar contra las fuerzas del caos!","在非排位的【召唤师峡谷】，【极地大乱斗】和【人机对战】里找我。我们在黎明时兜风！":"Me encontraréis en partidas de la Grieta del Invocador no clasificatorias, ARAM y Cooperativa vs. IA. ¡Partimos al amanecer!","咕噜噜……(“你不玩吗？我可为你准备了很多愚人节惊喜……”)":"Prrr... (¿Por qué no juegas? Te aguardan un montón de sorpresas miauravillosas en el April Fools...).","喵呜！ (“捏哈哈！有本事来抓我呀！”)":"¡Miau! (¿Estoy aquí o no estoy? ¡A ver si puedes echarme la zarpa!).","咪嗷呜！ (“混乱就是我的地盘！一场喵灾在等待！”)":"¡Prrr! (¡El caos es mi territorio! ¡Va a ser una gatástrofe!).","企鹅 盖伦":"Garen Pingu","盒子猫 萨科":"Shaco zarpitas"};
  const patterns = [];
  try {
    window.__tr = createTextReplacer({ dict, patterns, collect: true });
  } catch (error) {
    /* 最坏情况: 什么都没发生, 客户端保持原样 */
  }
})();
