/* 自动生成, 请勿手改 —— 由 scripts/build-text-plugin.ts 从 runtime.mjs + th_th/dict.json 生成 */
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
  const dict = {"护甲":"เกราะ","攻击速度":"ความเร็วโจมตี","格挡":"บล็อก","暴击几率":"โอกาสคริติคอล","暴击伤害":"ความเสียหายคริติคอล","能量":"พลังงาน","能量回复/5秒":"ฟื้นฟู Energy ต่อ 5 วินาที","经验值":"Exp","生命值":"พลังชีวิต","生命回复/5秒":"ฟื้นฟูพลังชีวิต ต่อ 5 วินาที","法术强度":"พลังเวท","移动速度":"ความเร็วเคลื่อนที่","法力":"มานา","法力回复/5秒":"ฟื้นฟูมานา ต่อ 5 วินาที","攻击力":"พลังโจมตี","魔法抗性":"ต้านทานเวท","闪避":"หลบ","经验获取":"ได้รับค่าประสบการณ์","生命回复":"ฟื้นฟูพลังชีวิต","生命偷取":"ดูดเลือด","法力回复":"ฟื้นฟูมานา","法术吸血":"เวทแวมไพร์","护甲于18级":"เกราะ ที่เลเวล 18","护甲穿透":"เจาะเกราะ","护甲穿透于18级":"เจาะเกราะ ที่เลเวล 18","暴击几率于18级":"โอกาสคริติคอล ที่เลเวล 18","暴击伤害于18级":"ความเสียหายคริติคอล ที่เลเวล 18","闪避于18级":"หลบ ที่เลเวล 18","能量于18级":"Energy ที่เลเวล 18","能量回复于18级":"ฟื้นฟู Energy ที่เลเวล 18","金/10秒":"ทองต่อ 10 วินาที","生命值于18级":"พลังชีวิต ที่เลเวล 18","生命回复于18级":"ฟื้นฟูพลังชีวิต ที่เลเวล 18","法术强度于18级":"พลังเวท ที่เลเวล 18","法术穿透":"เจาะเกราะเวท","法术穿透于18级":"เจาะเกราะเวท ที่เลเวล 18","移动速度于18级":"ความเร็วเคลื่อนที่ ที่เลเวล 18","法力于18级":"มานา ที่เลเวล 18","法力回复于18级":"ฟื้นฟูมานา ที่เลเวล 18","攻击力于18级":"พลังโจมตี ที่เลเวล 18","魔法抗性于18级":"ต้านทานเวท ที่เลเวล 18","死亡时间":"เวลารอฟื้น","死亡时间于18级":"เวลารอฟื้น ที่เลเวล 18","攻击速度于18级":"ความเร็วโจมตี ที่เลเวล 18","冷却缩减":"ลดคูลดาวน์","冷却缩减于18级":"ลดคูลดาวน์ที่เลเวล 18","穿甲":"โจมตีจุดตาย","穿甲于18级":"โจมตีจุดตาย ที่เลเวล 18","正在更新《英雄联盟》……":"กำลังอัปเดต League of Legends...",";annie;安妮;黑暗之女;heianzhinv;huonv;火女;an;hazn;hn":";annie",";kayle;kaier;凯尔;tianshi;天使;审判;ke;ts;shenpan;spts":";kayle",";xerath;zelasi;泽拉斯;tesila;特斯拉;yuanguwuling;远古巫灵;zls;tsl;ygwl":";xerath",";shyvana;龙女;longnv;xiwana;希瓦娜;龙血武姬;longxuewuji;ln;xwn;lxwj":";shyvana",";ahri;ali;阿狸;huli;狐狸;九尾妖狐;jiuweiyaohu;hl;jwyh":";ahri",";graves;格雷福斯;geleifusi;法外狂徒;fawaikuangtu;nanqiang;男枪;nq;glfs;fwkt":";graves",";fizz;feizi;chaoxihailing;菲兹;潮汐海灵;xiaoyuren;小鱼人;fz;cxhl;xyr":";fizz",";volibear;gouxiong;狗熊;wolibeier;沃利贝尔;不灭狂雷;bumiekuanglei;gx;wlbe;bmkl":";volibear",";rengar;shizigou;狮子狗;leienjiaer;雷恩加尔;aozhizhuiliezhe;傲之追猎者;szg;leje;azzlz":";rengar",";master yi;yidashi;易大师;jiansheng;剑圣;wuji;无极;yds;js;wjjs;yi":";master yi",";varus;weilusi;韦鲁斯;chengjiezhijian;惩戒之箭;wls;cjzj":";varus",";nautilus;taitan;泰坦;nuotilesi;诺提勒斯;shenhai;深海;ntls;sstt;tt":";nautilus",";viktor;weiketuo;维克托;jixiexianqu;机械先驱;三只手;sanzhishou;szs;wkt;jxxq;aoshuxianqu;asxq;奥术先驱":";viktor",";sejuani;zhunv;zhumei;猪女;猪妹;sezhuangni;瑟庄妮;beidizhinu;北地之怒;szn;zn;zm;bdzn":";sejuani",";fiora;剑姬;jianji;feiaona;菲奥娜;wushuang;无双;fan;fon;jj;wsjj":";fiora",";ziggs;zhadanren;炸弹人;吉格斯;jigesi;guicai;鬼才;baopo;爆破;jgs;bpgc;gc;zdr":";ziggs",";lulu;璐璐;露露;仙灵女巫;xianlingnvwu;ll;xlnw":";lulu",";draven;德莱文;delaiwen;文森特;wensente;rongyaoxingxingguan;荣耀行刑官;dlw;wst;ryxxg":";draven",";alistar;niutou;牛头;alisita;阿利斯塔;nt;alst":";alistar",";hecarim;hekalimu;赫卡里姆;renma;人马;zhanzhengzhiying;战争之影;hklm;rm;zzzy":";hecarim",";kha'zix;tanglang;螳螂;kazike;卡兹克;xukong;虚空;tl;kzk;xk":";kha'zix",";darius;delaiesi;德莱厄斯;nuoshou;诺手;dles;ns;诺克萨斯之手;nuokesasizhishou;nksszs":";darius",";jayce;jiesi;杰斯;weilaishouhuzhe;未来守护者;js;wlshz":";jayce",";lissandra;bingnv;冰女;lisangzhuo;丽桑卓;bingshuangnvwu;冰霜女巫;bn;lsz;bsnw":";lissandra",";ryze;faker;liulang;流浪;瑞兹;ruizi;fuwenfashi;符文法师;guangtou;光头;rz;ll;fwfs;gt":";ryze",";diana;daianna;黛安娜;jiaoyue;皎月女神;戴安娜;dan;jyns;jy":";diana",";quinn;kuiyin;奎因;niaoren;鸟人;demaxiyazhiyi;德玛西亚之翼;ky;dmxyzy":";quinn",";syndra;qiunv;球女;xindela;辛德拉;anheiyuanshou;暗黑元首;qn;xdl;ahys":";syndra",";aurelion sol;龙王;奥瑞利安;索尔;zhuxing;longwang;铸星;aoruilian;arla;lw;zxlw":";aurelion sol",";sion;saien;赛恩;wanglingzhanshen;亡灵战神;se;wlzs":";sion",";凯隐;kaiyin;kayn;暗裔魔镰;anyimolian;yingliuzhilian;影流之镰;ky;ayml;ylzl":";kayn",";zoe;zuoyi;佐伊;muguangxingling;暮光星灵;zy;mgxl;":";zoe",";zyra;jiela;婕拉;jingjizhixing;荆棘之兴;jl;jjzx":";zyra",";kai'sa;kasha;xukong;虚空;卡莎;ks;xkzn":";kai'sa",";Seraphine;salefenni;geji;slfn;xlgj;gj;萨勒芬妮;星籁;歌姬;酸辣粉;suanlafen":";Seraphine",";qiyana;qyn;ysnh;yuansunvhuang;奇亚娜;元素女皇;圈子妈;quanzima":";qiyana",";sivir;xiweier;希维尔;lunzima;轮子妈;zhanzhengnvshen;战争女神;xwe;lzm;zzns":";sivir",";gnar;naer;纳尔;mishizhiya;迷失之牙;ne;mszy":";gnar",";zac;zhake;扎克;shenghuamoren;生化魔人;zk;shmr":";zac",";yasuo;kuaile;fengnan;快乐;风男;亚索;jianhao;剑豪;jifeng;疾风;ys;jfjh;klfn":";yasuo",";soraka;naima;奶妈;索拉卡;suolaka;slk;nm;星妈;xingma;xm":";soraka",";vel'koz;大眼;dayan;weikezi;维克兹;xukong;虚空;dy;wkz;xkzy":";vel'koz",";taliyah;taliya;塔利亚;塔莉垭;yanque;岩雀;tly;yq":";taliyah",";camille;青钢影;卡蜜尔;qinggangying;kamier;qgy;kme":";camille",";akshan;阿克尚;影哨;the Rogue Sentinel;aks;akeshang;yingshao;ys":";akshan",";teemo;timo;提莫;tibaiwan;提百万;xunjiechihou;迅捷斥候;tm;xjch":";teemo",";tristana;xiaopao;小炮;paoniang;炮娘;崔丝塔娜;cuisitana;mailinpaoshou;麦林炮手;xp;cstn;mlps":";tristana",";warwick;langren;狼人;wolike;沃里克;祖安怒兽;zuan;wlk;lr;zans":";warwick",";olaf;aolafu;奥拉夫;kuangzhanshi;狂战士;alf;kzs":";olaf",";nunu;努努;xueren;雪人;xueyuanshuangzi;雪原双子;xr;xysz;nn":";nunu",";belveth;beierweisi;xukongnvhuang;brws;xknh;Void Empress;卑尔维斯;虚空;女皇;虚空女皇;nvhuang;nh":";belveth",";braum;bulong;布隆;fuleierzhuode;弗雷尔卓德;bl;flezd":";braum",";jhin;烬;戏命师;jin;wangyuan;望远;ximingshi;xms;wyj":";jhin",";kindred;qianjue;千珏;yonglieshuangzi;永猎双子;qj;ylsz":";kindred",";miss fortune;nvqiang;女枪;mf;eyunxiaojie;厄运小姐;haoyunjie;好运姐;shangjin;赏金;nq;eyxj;sj;hyj":";miss fortune",";ashe;aishe;爱射;aixi;艾希;hanbing;寒冰;as;ax;hb":";ashe",";zeli;zeri;zuanhuahuo;zahh;泽丽;zl;祖安花火":";zeri",";jinx;jinkesi;金克丝;baozou;luoli;暴走;萝莉;jks;bzll;powder;baobao;bb;爆爆":";jinx",";tahm kench;hama;蛤蟆;tamu;塔姆;hm;tm;河流之王;hlzw;heliuzhiwang":";tahm kench",";tryndamere;manwang;蛮王;taidamier;泰达米尔;mw;tdme":";tryndamere",";briar;the Restrained Hunger;贝蕾亚;狂厄蔷薇;bly;keqw;beileiya;kuangeqiangwei":";briar",";viego;Ruined King;佛耶戈;破败之王;v哥;foyege;fyg;pobaizhiwang;pbzw;破败王;pobaiwang;pbw":";viego",";saina;senna;赛娜;dihunshengqiang;涤魂圣枪;sn;dhsq":";senna",";lucian;aobama;奥巴马;luxian;卢锡安;shengqiangyouxia;圣枪游侠;abm;lxa;sqyx":";lucian",";zed;jie;劫;yingliuzhizhu;影流之主;ylzz":";zed",";jax;jiakesi;贾克斯;wuqidashi;武器大师;jks;wqds;武器":";jax",";kled;克烈;暴怒骑士;kelie;baonuqishi;kl;bnqs":";kled",";ekko;aike;艾克;时间刺客;shijiancike;ak;sjck":";ekko",";morgana;moganna;莫甘娜;duoluotianshi;堕落天使;mgn;dlts":";morgana",";vi;wei;蔚;pichengzhifaguan;皮城执法官;pczfg;violet;蔚奥莱;weiaolai;wal;楚雨荨;chuyuxun;cyx":";vi",";zilean;shiguang;laotou;时光;老头;jilan;基兰;sg;jl":";zilean",";aatrox;yatuokesi;亚托克斯;jianmo;剑魔;anyi;暗裔;ytks;jm;ayjm":";aatrox",";nami;namei;娜美;huanchaojiaoji;唤潮鲛姬;nm;hcjj":";nami",";azir;shahuang;沙皇;azier;阿兹尔;shamohuangdi;沙漠皇帝;sh;aze;smhd":";azir",";singed;lianjin;炼金;xinjide;辛吉德;lj;xjd":";singed",";evelynn;guafu;寡妇;yifulin;伊芙琳;tongkuzhiyong;痛苦之拥;gf;yfl;tkzy":";evelynn",";twitch;laoshu;老鼠;tuqi;图奇;wenyizhiyuan;瘟疫之源;ls;tq;wyzy":";twitch",";galio;jialiao;加里奥;zhengyijuxiang;正义巨像;jla;jlo;zyjx":";galio",";karthus;sige;死歌;kaersasi;卡尔萨斯;sg;kess":";karthus",";cho'gath;kejiasi;科加斯;dachongzi;大虫子;xukong;虚空恐惧;kjs;dcz;xkkj":";cho'gath",";amumu;阿木木;munaiyi;木乃伊;amm;mny":";amumu",";rammus;longgui;wangba;龙龟;王八;lamosi;拉莫斯;lms;lg;wb":";rammus",";anivia;bingniao;冰鸟;fenghuang;凤凰;ainiweiya;艾尼维亚;bn;fh;anwy":";anivia",";shaco;xiaochou;小丑;sake;萨科;xc;sk":";shaco",";youmi;yuumi;maomi;cat;mfmm;魔法猫咪;猫咪;魔法;悠米;ym;mm":";yuumi",";dr. mundo;mengduo;蒙多;zuan;祖安狂人;md;zakr":";dr. mundo",";samira;沙漠玫瑰;莎弥拉;shamila;desert rose;samila;shamomeigui;萨米拉;sml;smmg":";samira",";sona;qinnv;琴女;suona;娑娜;qinsexiannv;琴瑟仙女;sn;qn;qsxn":";sona",";kassadin;kasading;卡萨丁;xukong;虚空行者;xkxz;xukongxingzhe;ksd":";kassadin",";irelia;daomei;刀妹;airuiliya;艾瑞丽娅;daofengwuzhe;刀锋舞者;dm;arly;dfwz;女刀;nd;nvdao":";irelia",";twisted fate;tf;kapai;卡牌大师;cuisite;崔斯特;kp;kpds;kapaidashi;cst":";twisted fate",";janna;998;fengnv;风女;jiana;迦娜;fengbaozhinu;风暴之怒;fn;jn;fbzn":";janna",";gangplank;chuanzhang;船长;pulangke;普朗克;haiyangzhizai;海洋之灾;cz;plk;hyzz":";gangplank",";thresh;chuishi;锤石;hunsuodianyuzhang;魂锁典狱长;cs;hsdyz":";thresh",";corki;feiji;飞机;kuqi;库奇;yingyongtoudanshou;英勇投弹手;fj;kq;yytds":";corki",";illaoi;eluoyi;俄洛伊;haishoujisi;海兽祭司;chushouma;触手妈;大妈;dama;ely;hsjs;csm;dm":";illaoi",";rek'sai;leikesai;雷克塞;挖掘机;wajueji;xukongdundishou;虚空;lks;wjj;xkdds":";rek'sai",";ivern;艾翁;翠神;aiweng;cuishen;xiaoju;小菊;aw;cs;xj;xiaoshu;xs;小树":";ivern",";kalista;huabanxie;滑板鞋;kalisita;卡莉丝塔;fuchouzhimao;复仇之矛;hbx;klst;fczm":";kalista",";karma;shanzima;扇子妈;kaerma;卡尔玛;tianqizhe;天启者;kem;szm;tqz":";karma",";bard;bade;巴德;yinyoushiren;吟游诗人;xingjieyoushen;星界游神;bd;yysr;xjys":";bard",";taric;baoshi;宝石;talike;塔里克;waluolanzhidun;瓦洛兰之盾;tlk;bs;wllzd":";taric",";veigar;weijia;维迦;xieexiaofashi;邪恶小法师;wj;xiaofashi;小法师;xfs;xexfs;小法":";veigar",";trundle;jumo;巨魔;telangdeer;特朗德尔;tlde;jm":";trundle",";rakan;洛;幻翎;luo;huanling;fenghuangchuanqi;凤凰传奇;hl;fhcq":";rakan",";xayah;霞;逆羽;xia;niyu;fenghuangchuanqi;凤凰传奇;fhcq;ny":";xayah",";xin zhao;zhaoxin;赵信;xinye;信爷;zx;xy;debangzongguan;德邦总管;dbzg":";xin zhao",";swain;wuya;乌鸦;siweiyin;斯维因;nuokesasitongling;诺克萨斯统领;wy;swy;nksstl":";swain",";caitlyn;nvjing;女警;kaitelin;凯特琳;picheng;皮城;nj;ktl;pcnj;cupcake;xiaodangao;xdg;小蛋糕":";caitlyn",";ornn;奥恩;山隐之焰;aoen;shanyinzhiyan;ae;syzy;yang;羊":";ornn",";解脱者;sailasi;sls;jtz;jietuozhe;sylas;Unshackled;塞拉斯":";sylas",";nikou;neeko;wanhua;whtl;nk;妮蔻;万花通灵":";neeko",";efeiliusi;aphelios;the Weapon of Faith;canyuezhisu;厄斐琉斯;残月之肃;无E烦;wuefan;wuyifan;月男;yuenan;efls;cyzs;yn;wyf":";aphelios",";rell;ruier;芮尔;铁女;Iron Maiden;镕铁少女;re;rongtieshaonv;rtsn;tienv;tn;mamei;mm;马妹":";rell",";blitzcrank;jiqiren;机器人;bulici;布里茨;jqr;blc;zhengqi;蒸汽;zqjqr":";blitzcrank",";malphite;shitouren;石头人;mofeite;墨菲特;rongyanjushou;熔岩巨兽;str;mft;ryjs;ry":";malphite",";katarina;katelinna;卡特琳娜;buxiangzhiren;不祥之刃;卡特;kate;ktln;kt;bxzr":";katarina",";pyke;paike;派克;xuegangguiying;血港鬼影;pk;xggy":";pyke",";nocturne;mengyan;梦魇;moteng;魔腾;my;mt;夜曲;yequ;yq":";nocturne",";maokai;茂凯;dashu;大树;niuqushujing;扭曲树精;mk;ds;nqsj":";maokai",";renekton;eyu;鳄鱼;leikedun;雷克顿;huangmotufu;荒漠屠夫;lkd;hmtf":";renekton",";jarvan iv;huangzi;皇子;jiawensishi;嘉文四世;hz;jwss;dmxyhz;demaxiyahuangzi;德玛西亚皇子":";jarvan iv",";urgot;pangxie;螃蟹;ejiate;厄加特;wuweizhanche;无畏战车;ejt;dpx;px;大螃蟹;wwzc":";urgot",";elise;zhizhu;蜘蛛;yilisi;伊莉丝;zznh;女皇;yls":";elise",";orianna;fatiao;发条;aolianna;奥莉安娜;ft;alan;魔灵;ftml":";orianna",";wukong;悟空;houzi;猴子;qitiandasheng;齐天大圣;孙悟空;swk;wk;hz;qtds;sunwukong":";wukong",";brand;huonan;火男;bulande;布兰德;fuchouyanhun;复仇焰魂;bld;hn;fcyh":";brand",";lee sin;xiazi;盲僧;瞎子;mangseng;liqing;李青;xz;ms;lq":";lee sin",";vayne;uzi;weien;薇恩;anyelieshou;暗夜猎手;we;ayls":";vayne",";rumble;lanbo;兰博;jixiegongdi;机械公敌;lb;jxgd":";rumble",";cassiopeia;shenv;蛇女;kaxiaopeiya;卡西奥佩娅;moshezhiyong;魔蛇之拥;sn;kxopy;mszy":";cassiopeia",";leblanc;yaoji;妖姬;lefulan;乐芙兰;yj;lfl;诡术妖姬;guishu;gsyj":";leblanc",";vex;gloomist;薇古丝;愁云使者;vgs;cysz;wgs;weigusi;veigusi;chouyunshizhe;aybb;aoyebobi;熬夜波比":";vex",";skarner;xiezi;蝎子;sikana;斯卡纳;shanggulingzhu;上古领主;xz;skn;sglz":";skarner",";heimerdinger;datou;大头;dafamingjia;大发明家;heimodingge;黑默丁格;dt;dmmj;hmdg;famingjia;fmj;发明家":";heimerdinger",";nasus;goutou;狗头;neisesi;内瑟斯;shamosishen;沙漠死神;nss;gt;smss":";nasus",";nidalee;naidali;奶大力;baonv;豹女;naideli;奈德丽;kuangyenvlieshou;狂野女猎手;ndl;bn;kynls":";nidalee",";udyr;wudier;乌迪尔;shoulingxingzhe;兽灵行者;ud;wde;slxz;xiaoyan;xy;萧炎;野区萧炎;yequxiaoyan;yqxy":";udyr",";yone;永恩;封魔剑魂;yongen;fengmojianhun;fmjh;ye":";yone",";poppy;bobi;波比;圣锤之毅;shengchuizhiyi;bb;sczy":";poppy",";gragas;jiutong;酒桶;gulajiasi;古拉加斯;gljs;jt":";gragas",";ambessa;anbeisa;tiexielangmu;tiexuelangmu;txlm;abs;安蓓萨;铁血狼母;狼母;langmu;lm":";ambessa",";vladimir;xixuegui;吸血鬼;fulajimier;弗拉基米尔;xinghongshougezhe;猩红收割者;xxg;fljme;xhsgz":";vladimir",";pantheon;pansen;潘森;sibada;斯巴达;buquzhiqiang;不屈之枪;ps;bqzq":";pantheon",";mel;jingyingliuguang;meier;梅尔;me;镜影流光;jylg;流光镜影;liuguangjingying;lgjy":";mel",";yunana;芸阿娜;不破之誓;the Unbroken Faith;yan;yunara;bupozhishi;bpzs":";yunara",";locke;灰烬驱魔人;洛克;the Ashen Exorcist;hjqmr;huijinqumoren;luoke;lk":";locke",";ezreal;ez;yize;伊泽;tanxianjia;探险家;yz;txj;yizeruier;伊泽瑞尔;yzre":";ezreal",";mordekaiser;tienan;铁男;modekaisa;莫德凯撒;tiekaiminghun;铁铠冥魂;mdks;jsds;jinshudashi;金属大师;modeganqing;莫得感情;tn;mdgq;tkmh":";mordekaiser",";yorick;yuelike;约里克;juemu;掘墓;muhunren;牧魂人;ylk;jm;mhr":";yorick",";akali;阿卡丽;liqunzhici;离群之刺;akl;lqzc":";akali",";kennen;kainan;凯南;dianhaozi;电耗子;kuangbaozhixin;狂暴之心;kn;kbzx":";kennen",";garen;gailun;盖伦;德玛西亚之力;demaxiyazhili;gl;dmxyzl":";garen",";seti;sett;the Boss;瑟提;st;腕豪;wh;wanhao;男拳;nanquan;nq":";sett",";莉莉娅;liliya;hxbl;hanxiubeilei;lillia;含羞;蓓蕾;妮马;蔻马;nima;kouma;鹿女;lunv;梦鹿;menglu;beilei;lly":";lillia",";gwen;gewen;the Hallowed Seamstress;灵罗娃娃;格温;gw;llww;lingluowawa;剪子妈;jianzima;jzm;剪妹;jianmei;jm;一剪没;yijianmei;yjm;滚;gun":";gwen",";lienata;lnt;lianjinnanjue;ljnj;renata;chemtech;baroness;烈娜塔;炼金男爵;glsk;gelasike;戈拉斯克;glasc":";renata glasc",";leona;nvtan;rinv;女坦;日女;leiouna;蕾欧娜;shuguangnvshen;曙光女神;lon;rn;nt;sgns":";leona",";阿萝拉;aluola;aurora;双界灵兔;shuangjielingtu;sjlt;all;兔女;tunv;tn;tuzi;tz;兔子":";aurora",";nila;nilah;the Joy Unbound;尼菈;nl;不羁之悦;bujizhiyue;bjzy":";nilah",";k'sante;kuisangti;kst;nazumangrongyao;nzmry;奎桑提;纳祖芒荣耀":";k'sante",";fiddlesticks;daocaoren;稻草人;feidetike;费德提克;yuangukongju;远古恐惧;dcr;fdtk;ygkj":";fiddlesticks",";malzahar;mazha;蚂蚱;maerzhaha;玛尔扎哈;xukongxingzhe;虚空先知;mezh;mz;xkxz":";malzahar",";simode;smolder;youlong;long;chiyan;chulong;chiyanchulong;炽;龙;炽炎雏龙;斯莫德;smd;cycl;yl;幼龙;xiaolongren;xlr;小龙人;小火龙;xiaohuolong;xhl;mabaolong;mbl;妈宝龙":";smolder",";milio;the gentle flame;mingzhu;miliou;mlo;mz;米利欧;明烛":";milio",";zaahen;The Unsundered;不落魔锋;亚恒;yaheng;buluomofeng;yh;blmf":";zaahen",";talon;nandao;男刀;tailong;泰隆;daofengzhiying;刀锋之影;tl;nd;df":";talon",";hwei;彗;hui;yihuashi;the Visionary;huajia;画家;异画师;yhs;hj;maobiren;mbr;毛笔人":";hwei",";riven;ruiwen;锐雯;fangzhuzhiren;放逐之刃;rw;fzzr":";riven",";naafiri;the Hound of a Hundred Bites;纳亚菲利;百裂冥犬;nayafeili;nyfl;bailiemingquan;blmq;gou;狗;dog":";naafiri",";kog'maw;dazui;大嘴;kegemo;克格莫;shenyuanjukou;深渊巨口;kgm;dz;shenyuanjukou;syjk":";kog'maw",";shen;慎;muguangzhiyan;暮光之眼;yaozi;腰子;mgzy;yz":";shen",";lux;lakesi;拉克丝;guanghuinvlang;光辉女郎;lks;ghnl":";lux","见习刺客":"Rogue","初级刺客":"Prowler","中级刺客":"Cutthroat","高级刺客":"Reaper","杀戮之影":"Slayer","杀戮宗师":"Executioner","死神":"Deathmaster","见习战士":"Scrapper","初级战士":"Brawler","中级战士":"Warrior","高级战士":"Veteran","征服之刃":"Destroyer","征服宗师":"Warmonger","战神":"Warlord","见习法师":"Initiate","初级法师":"Conjurer","中级法师":"Invoker","高级法师":"Magus","织法之杖":"Warlock","织法宗师":"Sorcerer","法神":"Archmage","见习射手":"Tracker","初级射手":"Strider","中级射手":"Scout","高级射手":"Ranger","鹰隼之眼":"Pathfinder","射击宗师":"Sharpshooter","狙神":"Sniper","见习辅助":"Aide","初级辅助":"Protector","中级辅助":"Keeper","高级辅助":"Defender","庇护之光":"Guardian","庇护宗师":"Sentinel","守护之神":"Warden","见习坦克":"Grunt","初级坦克":"Bruiser","中级坦克":"Bulwark","高级坦克":"Enforcer","无畏之盾":"Brute","无畏宗师":"Colossus","巨神":"Juggernaut","登录失败，请重试。":"ไอดีหรือรหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง","一个意料之外的错误发生了":"เกิดข้อผิดพลาดที่ไม่คาดคิดขึ้น","所有角色定位":"หน้าที่ทั้งหมด","刺客":"มือสังหาร","战士":"ไฟเตอร์","法师":"เมจ","射手":"มาคส์แมน","辅助":"ซัพพอร์ต","坦克":"แทงค์","错误代码":"Error code","我们无法加载这个页面。如果你的互联网连接没问题的话，请稍等几分钟然后重试。":"เราไม่สามารถโหลดหน้านี้ได้ หากระบบอินเตอร์เน็ตของคุณไม่มีปัญหา กรุณารอสักครู่แล้วลองเข้าใหม่อีกครั้ง","重试":"ลองใหม่อีกครั้ง","{{feature}}目前已被禁用":"{{feature}} ถูกปิดเอาไว้อยู่ในตอนนี้","这个功能目前已被禁用":"ระบบนี้ถูกปิดเอาไว้อยู่ในตอนนี้","暂未实装":"ยังไม่เสร็จสิ้น","创建房间":"สร้างล็อบบี้","退出":"ออก","对水晶之痕的简短描述。":"คำอธิบายของ Crystal Scar","和随机选择英雄的队友一起，去摧毁敌人的水晶枢纽。":"ต่อสู้กันเป็นทีม 5 คน โดยการสุ่มแชมเปี้ยน บุกผ่านสะพานและเข้าทำลาย Nexus ของฝ่ายศัตรู","正义之地最古老最威严的战场当属召唤师峡谷。几百年间无数对立的召唤师们在这片战场上延续着战斗，这片战场也因此而得名。有三条不同的道路穿越整个战场。与友军一起攻击敌人最脆弱的地方，摧毁他们的基地！":"พื้นที่เก่าแก่ที่สุด และเป็นพื้นที่ที่ศักดิ์สิทธิ์ที่สุดของ Field of Justice ที่รู้จักกันในนาม Summoner's Rift ในป่าอันห่างไกลซึ่งอยู่ระหว่าง Frejlord, Serpentine River และเทือกเขา Ironspike","对扭曲丛林的简短描述。":"คำอธิบายของ Twisted Treeline","水晶之痕":"Crystal Scar","水晶\n之痕":"CRYSTAL SCAR","已被禁用，并在维修中。我们对此带来的不便深表歉意。":"ถูกปิดไว้ชั่วคราว เพื่อรอการปิดปรับปรุง พวกเราต้องขออภัยในความไม่สะดวกด้วย","嚎哭深渊":"Howling Abyss","嚎哭\n深渊":"HOWLING\nABYSS","召唤师峡谷":"Summoner's Rift","召唤师\n峡谷":"SUMMONER'S RIFT","扭曲丛林":"Twisted Treeline","扭曲\n丛林":"TWISTED TREELINE","创建自定义游戏":"สร้างห้องเอง","这个模式目前已被禁用":"โหมดนี้ถูกปิดเอาไว้อยู่","加入自定义游戏":"เข้าร่วมห้อง","匹配模式":"ทั่วไป","排位赛":"เกมจัดอันดับ","新手教程":"โหมดฝึกสอน","人机":"เล่นสู้กับบอท","极地大乱斗":"ARAM","全随机（极地大乱斗）1v1":"All Random (ARAM) 1 vs 1","全随机（极地大乱斗）2v2":"All Random (ARAM) 2 vs 2","全随机（极地大乱斗）3v3":"All Random (ARAM) 3 vs 3","全随机（极地大乱斗）5v5":"All Random (ARAM) 5 vs 5","全随机（极地大乱斗）6v6":"All Random (ARAM) 6 vs 6","全随机人机对战（极地大乱斗）5v5":"All Random vs AI (ARAM) 5 vs 5","统治战场5v5":"Dominion 5 V 5","极地大乱斗5v5":"ARAM 5 V 5","经典模式5v5":"คลาสสิค 5 V 5","经典模式3v3":"คลาสสิค 3 V 3","全随机（大乱斗）":"ALL RANDOM (ARAM)","内部服务器错误，请稍后重试":"เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ โปรดลองอีกครั้งในภายหลัง","你已经与新闻服务断开了连接。请手动重新连接。":"คุณขาดการเชื่อมต่อจากบริการข่าว โปรดลองเชื่อมต่ออีกครั้ง","经常使用":"ผู้เล่นประจำ","确认":"ตกลง","是":"ใช่","否":"ไม่","接受":"ยอมรับ","拒绝":"ปฏิเสธ","最终用户许可协议":"สัญญาอนุญาตผู้ใช้งาน","使用条款":"ข้อกำหนดการใช้งาน","取消":"ยกเลิก","授予邀请":"ยอมรับคำเชิญ","移出玩家":"เตะ","提升为队长":"แต่งตั้งให้เป็นกัปตัน","撤回邀请":"ถอนคำเชิญ","通过拖动来邀请玩家。":"ลากมาเพื่อชักชวน","寻找对局":"ค้นหาห้อง","阻塞":"ถูกปิดเอาไว้","邀请":"ชักชวน","添加":"เพิ่ม","邀请玩家":"ชักชวนผู้เล่น","发送邀请":"ส่งคำเชิญ","输入玩家名称":"ใส่ชื่อผู้เล่น","已邀请":"เชิญแล้ว","你真的想移出{{summonerName}}吗？":"คุณต้องการที่จะเตะ {{summonerName}} จริงหรือ?","你已被移出了组房间":"คุณถูกเตะออกจากล็อบบี้เกม","与你的好友一起玩，你就会获得组队奖励！更多好友组队意味着更多战利品，所以快去组队吧！":"เนื่องจากการเล่นกับเพื่อน คุณจึงได้รับรางวัลปาร์ตี้! เพื่อนยิ่งมากก็ยิ่งได้รางวัลมาก มาตั้งทีมกันเถอะ!","组队奖励":"รางวัลปาร์ตี้","与你的好友一起玩来获得蓝色精萃奖励！更多好友组队意味着更多战利品！":"รับรางวัล IP เพิ่ม โดยการเข้าเล่นกับเพื่อนๆ ยิ่งเพื่อนมาก ยิ่งได้มาก!","快组队吧！":"จัดทีม!","待定":"รอดำเนินการ","已推荐":"แนะนำ","<span class='click-instruction'>点击以添加{{pointsAssignedOnClick}}点。</span><span class='click-instruction'>按住SHIFT键点击以添加1点。</span>":"<span class='click-instruction'>คลิกเพื่อเพิ่ม {{pointsAssignedOnClick}} แต้ม</span><span class='click-instruction'>กด Shift + คลิกเพื่อเพิ่มหนึ่งแต้ม</span>","<span class='click-instruction'>点击以添加1点。</span>":"<span class='click-instruction'>คลิกเพื่อเพิ่มหนึ่งแต้ม</span>","下个点数":"แต้มถัดไป","无法在服务器上创建一个天赋页。也许是因为连接问题。":"ล้มเหลวในการสร้างหน้ามาสเตอรี่บนเซิร์ฟเวอร์ มันอาจเป็นเพราะปัญหาการเชื่อมต่อ","添加新的天赋页":"เพิ่มหน้าใหม่","天赋页{{number}}":"มาสเตอรี่หน้า {{number}}","你确定想要删除该页吗？":"คุณมั่นใจแล้วหรือว่าจะลบหน้านี้จริง?","删除天赋页":"ลบหน้านี้","编辑天赋页名称":"แก้ไขชื่อหน้า","可用点数：{{number}}":"แต้มที่ใช้ได้: {{number}}","重置此天赋页的点数":"รีเซ็ตแต้มในหน้านี้","重置此天赋树的点数":"รีเซ็ตแต้มในสายนี้","点击这里来保存你对天赋页的所有改动。":"คลิกเพื่อบันทึกการเปลี่ยนแปลงทั้งหมดในหน้ามาสเตอร์รี่ของคุณ","由于连接失败，无法保存天赋页面。":"บันทึกหน้ามาสเตอรี่ล้มเหลวเนื่องจากปัญหาเน็ตเวิร์ก","保存":"บันทึก","你的天赋有尚未保存的改动。你想要保存吗？":"คุณยังไม่ได้บันทึกการเปลี่ยนแปลงของมาสเตอรี่ คุณต้องการบันทึกตอนนี้หรือไม่?","需要在<span class='mastery-type'>{{type}}</span>至少分配{{ranks}}点":"ต้องใช้ {{ranks}} แต้มใน <span class='mastery-type'>{{type}}</span>","需要在{{prereq}}至少分配{{ranks}}点":"ต้องใช้ {{ranks}} ขั้นใน {{prereq}}","剩余{{pointsLeft}}点数":"เหลือ {{pointsLeft}} แต้ม","诡诈":"CUNNING","凶猛":"FEROCITY","坚决":"RESOLVE","诡诈系":"Cunning","凶猛系":"Ferocity","坚决系":"Resolve","房间":"ปาร์ตี้","藏品":"คอลเลกชัน","冠军杯赛":"Clash","电竞":"Esports","主页":"หน้าแรก","经典模式":"Classic","战利品/圣堂":"สมบัติ","新闻":"ข่าว","云顶之弈":"TFT","幸运商店":"ร้านค้าลับ","生涯":"โปรไฟล์","商城":"ร้านค้า","海斗第3季":"Mayhem Set 3","更多信息":"ข้อมูลเพิ่มเติม","检测到必要更新":"ตรวจพบความต้องการอัปเดต","你的网络连接出问题了。如果你目前还没有连接上互联网，请先连接互联网。如果你已经连上互联网了但无法连接上《英雄联盟》，请查阅我们的<a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>客服信息</a>来看看是否有可行的解决方案。":"มีปัญหากับการเชื่อมต่อของคุณ หากคุณไม่ได้เชื่อมต่ออินเทอร์เน็ตอยู่ในขณะนี้ กรุณาดำเนินการเชื่อมต่อ ถ้าคุณออนไลน์แล้วแต่ยังเชื่อมต่อเข้า League of Legends ไม่ได้ คุณสามารถตรวจสอบที่ <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>หน้าช่วยเหลือผู้เล่น</a> เพื่อค้นหาหนทางแก้ไข","好的":"ตกลง","我们复原了一个较旧版本的《英雄联盟》。现在我们将尝试把它更新为最新版本。":"พวกเราได้ทำการกู้คืนเวอร์ชันเก่าของ League of Legends แล้วในตอนนี้พวกเราจะพยายามอัปเดตให้เป็นเวอร์ชันล่าสุด","{{megabytes}} MB / {{kilobytes_per_second}} KB/秒":"{{megabytes}} MB @ {{kilobytes_per_second}} KBps","在你安装目录下的文件权限正在阻止《英雄联盟》的安装。请按“OK”键，然后我们将尝试唤起你的操作系统的权限管理器。":"ไม่สามารถติดตั้งเกมในแฟ้มติดตั้งของคุณเนื่องจากต้องมีการอนุญาตให้เข้าถึงไฟล์ก่อน กรุณากด 'ตกลง' และเราจะลองเปิดตัวจัดการอนุญาตเข้าถึงไฟล์ให้คุณ","在连接至服务器时出问题了。请检查你的网络连接并重启补丁器。如果你的网络连接没有问题，请联系客服进行处理。":" มีปัญหาในการเชื่อมต่อไปยังเซิร์ฟเวอร์ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตของคุณและลองเปิดตัวช่วยแพตช์ใหม่อีกครั้ง ถ้าไม่พบปัญหาการเชื่อมต่ออินเตอร์เน็ตของคุณ โปรดดำเนินการแก้ไขตามขั้นตอนใน <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/201752664\" target='_blank'>หน้าช่วยเหลือผู้เล่น</a> เพื่อค้นหาหนทางแก้ไข","补丁器无法下载内容至你的硬盘。请检查下你的电脑，至少需要8GB的空闲容量和写入硬盘的必要权限才能安装《英雄联盟》。你可以联系我们的客服来获取更多有关这个错误的帮助。*注意*：点击“是”将关闭客户端。":"ไม่สามารถดาวน์โหลดแพตช์ลงในฮาร์ดไดรฟ์ของคุณได้ ข้อผิดพลาดนี้มักเกิดจากพื้นที่ดิสก์ไม่เพียงพอสำหรับการดาวน์โหลด กรุณาตรวจสอบให้แน่ใจว่าคอมพิวเตอร์ของคุณมีพื้นที่ว่างอย่างน้อย 8 GB บนไดรฟ์ที่ติดตั้ง League และคุณให้สิทธิ์ที่จำเป็นในการเขียนข้อมูลลงในไดรฟ์นั้น สำหรับความช่วยเหลือเพิ่มเติมเกี่ยวกับข้อผิดพลาดนี้ โปรดดูขั้นตอนการแก้ไขปัญหา <a href=\"https://support-leagueoflegends.riotgames.com/hc/articles/202969434\" target='_blank'>ที่นี่</a> หมายเหตุ: การคลิก \"ตกลง\" จะเป็นการปิดไคลเอนต์","我们的服务器出故障了，并且在阻止你下载补丁内容。我们正在给服务器另一次机会。你可以<a href=\"http://lol.qq.com/act/a20150326dqpd/\" target='_blank'>点此</a>查看我们的服务器状态。":"บางอย่างอาจเกิดขึ้นกับเซิร์ฟเวอร์ของเรา และมันได้ขัดขวางทำให้คุณไม่สามารถทำการแพตช์ได้ พวกเรากำลังลองแพตช์ใหม่อีกครั้ง ในขณะเดียวกันคุณสามารถตรวจสอบสถานะเซิร์ฟของเราได้<a href=\"http://status.leagueoflegends.com\" target='_blank'>ที่นี่</a>","《英雄联盟》无法更新，因为你没有足够的硬盘空间。请至少释放{{Bytes}}空间然后重试。":"League ไม่สามารถทำการอัปเดตได้เนื่องจากคุณมีพื้นที่ว่างไม่เพียงพอ กรุณาเพิ่มพื้นที่อย่างน้อย {{Bytes}} และลองใหม่อีกครั้ง","补丁更新失败，并且我们不确定原因是什么。请重启客户端并重试补丁更新。":"การแพตช์ล้มเหลวและพวกเรายังไม่แน่ใจว่ามันเกิดขึ้นได้อย่างไร โปรดลองทำการเปิดไคลเอนต์ใหม่ แล้วลองแพตช์อีกครั้ง","预计用时 {{number}}分钟":"เวลาโดยประมาณ {{number}} นาที","好":"ตกลง","文件无法写入硬盘。请检查你是否有足够的磁盘空间和必要的许可。":"เขียนไฟล์ลงดิสก์ล้มเหลว โปรดตรวจสอบให้แน่ใจว่าคุณมีพื้นที่ว่างมากเพียงพอ","已修复档案：{{number}}":"ไฟล์ที่ได้รับการซ่อมแซม: {{number}}","已扫描的文件：{{number}}":"แสกนไฟล์แล้ว: {{number}}","联盟客户端":"LEAGUE CLIENT","游戏客户端":"GAME CLIENT","我们的服务器发生了些状况，导致你无法从服务器中获得更新文件。我们正在对服务器进行停机维护。在维护时，你可以在这里查看我们的服务器状态。":"บางสิ่งก็ขึ้นอยู่กับทางเซิร์ฟเวอร์ของเรา และมันกำลังขัดขวางการอัปเดตแพตช์ของคุณ พวกเรากำลังลองใหม่อีกครั้ง ในขณะเดียวกัน คุณสามารถตรวจสอบสถานะของเซิร์ฟเวอร์ของเราที่นี่","这个错误也许由以下现网内部事故导致：":"เหตุการณ์เหล่านี้อาจทำให้เกิดข้อผิดพลาดได้:","我们已经将这个安装程序恢复至一个较早的《英雄联盟》版本、现在我们将尝试将它更新至最新版本。":"พวกเราได้ทำการซ่อมแซมการติดตั้งให้แก่ League of Legends ในเวอร์ชันเก่า ในตอนนี้พวกเราจะพยายามทำการแพตช์ให้กลายเป็นเวอร์ชันล่าสุด","正在应用版本补丁":"กำลังแพตช์","正在下载文件":"กำลังดาวน์โหลดไฟล์","正在提取所需的版本数据":"กำลังดึงข้อมูลจำเป็นสำหรับแพตช์","正在安装":"กำลังติดตั้ง","正在下载":"กำลังดาวน์โหลด","正在修复":"กำลังซ่อมแซม","正在扫描":"กำลังสแกน","修复":"ซ่อมแซม","抱歉！我们在你的安装过程中检测到一些数据损坏。你想要修复受损的文件么？":"ขออภัย! พวกเราตรวจพบข้อมูลบางส่วนเสียหายในการติดตั้งของคุณ คุณอยากจะซ่อมแซมไฟล์ที่เสียเลยหรือไม่?","更新已完成下载。你必须重启客户端才能让更新生效。":"ดาวน์โหลดอัปเดตเสร็จเรียบร้อยแล้ว คุณต้องเริ่มต้นเปิด League of Legends ใหม่อีกครั้ง ก่อนที่การอัปเดตจะส่งผล","现在还不行":"ไม่ใช่ตอนนี้","重新启动":"เริ่มต้นใหม่","第{{current_step}}步（共{{total_steps}}步）":"ขั้นที่ {{current_step}} จาก {{total_steps}}","更新失败，而我们不确定是什么原因。点击我们的客服页面{{support page}}来查找可能的解决方法。":"การแพตช์ล้มเหลว แต่เราก็ไม่แน่ใจว่าเป็นเพราะอะไร ลองตรวจสอบที่ {{support page}} เพื่อค้นหาทางแก้ไข","正在更新……":"กำลังอัปเดต...","在更新《英雄联盟》时出现了一个问题。我们正在复原《英雄联盟》的备份版本，并会在你重新启动后再次尝试":"พบปัญหาในการอัปเดต League of Legends พวกเราจะทำกู้คืนเวอร์ชันสำรองของ League of Legends แล้วลองใหม่อีกครั้งหลังจากที่คุณเริ่มต้นการทำงานใหม่","游戏仍在进行中…":"เกมยังดำเนินการอยู่...","全随机":"ALL RANDOM","跳过等待，直接开始下一局游戏。":"ข้ามการรอสถิติเกม","开始游戏":"เริ่มเกม","可用":"ใช้งานได้","剩余1日":"เหลืออีก 1 วัน","剩余{{days}}天":"เหลืออีก {{days}} วัน","金币加成":"IP BOOST","网吧特权加成":"Loyalty Boost","下一个奖励的进度":"โบนัสถัดไปใน","下一次重随的进度":"สุ่มใหม่ถัดไป","没有激活加成":"ไม่มี Boost ที่เปิดใช้งาน","剩余1胜":"เหลือชนะได้อีก 1 ครั้ง","剩余{{wins}}胜场":"เหลือชนะได้อีก {{wins}} ครั้ง","双倍经验卡":"XP BOOST","记分板":"กระดานคะแนน","下一个":"ถัดไป","失败":"พ่ายแพ้","第二名":"อันดับ 2","第1名":"1st","蓝色精萃":"BE","全员战斗加成蓝色精萃已获得":"ได้รับ BE เพิ่มจาก BATTLE BOOST","蓝色精萃加成":"BE BOOST","当天首次胜利":"ชัยชนะครั้งแรกของวัน","蓝色精萃获取":"ได้รับ BE","特权加成蓝色精萃已获取":"ได้รับ BE เพิ่มจาก LOYALTY BOOST","统治战场蓝色精萃加成":"โบนัส BE จาก ODIN","小队奖励蓝色精萃加成已获得":"ได้รับโบนัส BE จากรางวัลปาร์ตี้แล้ว","排队加成已获取":"ได้รับโบนัสจากคิวที่เล่นแล้ว","逃兵":"ออกจากเกม","等级":"เลเวล","此负场不作记录":"ได้รับการป้องกันการพ่ายแพ้","加成点数":"แต้มโบนัส","点数获取":"ได้รับแต้มแล้ว","总计：":"รวมทั้งหมด:","胜利":"ชนะ","点数":"แต้ม","总经验":"รวม XP","特权加成经验已获取":"ได้รับ XP เพิ่มจาก LOYALTY BOOST","经验已获取":"ได้รับ XP มาแล้ว","还需{{points}}点即可到达{{level}}级":"{{points}} แต้ม เพื่อให้ถึงเลเวล {{level}}","重新连接":"เชื่อมต่ออีกครั้ง","游戏已经结束。你现在将返回主页。":"เกมสิ้นสุดแล้ว ตอนนี้ คุณจะย้อนกลับไปยังหน้าล็อบบี้","您中途退出游戏，\n请重新连接。":"เกมที่คุณร่วมยังดำเนินต่อไปอยู่ กรุณาเชื่อมต่อกลับเข้าเกม","添加好友":"เพิ่มเพื่อน","首页":"หน้าแรก","再玩一次":"เล่นอีกครั้ง","审核用的举报已经发送。感谢您的反馈。":"รายงานได้ถูกส่งไปเพื่อรอการพิจารณาแล้ว ขอบคุณ","你已经用完了所有可用的奖励。":"คุณใช้แต้มทั้งหมดที่ใช้ได้แล้ว","确定":"ตกลง","北":"เหนือ","队伍2":"ทีม 2","南":"ใต้","队伍1":"ทีม 1","查看高级详情":"ดูรายละเอียดขั้นสูง","附加评论":"ความคิดเห็นเพิ่มเติม","给敌方放水":"ให้ความช่วยเหลือทีมฝ่ายตรงข้าม","在这里输出评论":"เขียนความคิดเห็นได้ที่นี่","不当的用户名":"ชื่อไม่เหมาะสม","故意送人头":"เจตนาแจกแต้ม","挂机":"ออกเกม / AFK","消极态度":"ทำกิริยาไม่เหมาะสม","不与团队进行沟通":"ไม่ติดต่อสื่อสารกับทีม","攻击性的语言":"ใช้ข้อความที่รุนแรง และหยาบคาย","举报":"รายงาน","举报玩家":"รายงานผู้เล่น","滥发信息":"พยายามสแปม","无法举报这个玩家。请稍后再试。":"ไม่สามารถรายงานผู้เล่นคนนี้ได้ โปรดลองใหม่อีกครั้งในภายหลัง","玩家水平过低":"ผู้เล่นไร้ฝีมือ","口头谩骂":"ใช้ข้อความที่หยาบคายหรือลามกอนาจาร","态度友好":"เพื่อนผู้แสนดี","乐于助人":"ผู้รอบรู้","可敬的对手":"ศัตรูผู้น่ายกย่อง","无法称赞这个玩家。请稍后再试。":"ไม่สามารถให้แต้มแก่ผู้เล่นคนนี้ได้ โปรดลองใหม่อีกครั้งในภายลัง","团队合作":"ทีมเวิร์ค","助攻":"ช่วยเหลือ","英雄击杀":"สังหารแชมเปี้ยน","死亡":"ตาย","金币获取":"ได้รับทอง","小兵击杀":"สังหารมินเนี่ยน","该局总分":"ผลคะแนน","召唤师等级：":"เลเวลซัมมอนเนอร์:","加成":"BOOST","你确定要从英雄选择阶段离开吗？":"คุณจะออกในขณะเลือกแชมเปี้ยนจริง ๆ หรือ?","一位玩家秒退了；你已经回到了房间。":"มีผู้เล่นออกจากเกม; คุณจึงถูกส่งกลับไปยังล็อบบี้","敌方队伍":"ทีมศัตรู","你有{{rerolls}}个可用的英雄重随机会。":"คุณเหลือการสุ่มแชมเปี้ยนใหม่ได้อีก {{rerolls}} ครั้ง","这个召唤师技能已被禁用。":"เวทนี้ถูกปิดเอาไว้","等级需求：{{level}}":"ถูกล็อกไว้จนกว่าจะเลเวล {{level}}","{{actor}}正在和其他人交换":"{{actor}} กำลังแลกเปลี่ยนกับคนอื่นอยู่","这个交换已被取消。":"การแลกเปลี่ยนนี้ถูกยกเลิก","交换已被拒绝。":"การแลกเปลี่ยนนี้ถูกยกเลิก","还不能发出交换请求。请重试。":"ไม่สามารถขอแลกเปลี่ยนได้ โปรดลองใหม่อีกครั้ง","{{actor}}想要用{{entity1}}交换{{entity2}}。":"{{actor}} ต้องการสลับ {{entity1}} กับ {{entity2}}","用{{entity1}}交换{{entity2}}。":"สลับ {{entity1}} กับ {{entity2}}","正在等待{{actor}}回应你的交换请求……":"รอ {{actor}} ตอบกลับข้อเสนอในการสลับของคุณ...","己方队伍":"ทีมของคุณ","接受！":"ยอมรับ!","{{summonerName}}在英雄选择时离开。你已重新回到房间。":"{{summonerName}} ออกในระหว่างการเลือกแชมเปี้ยน คุณจะกลับไปที่ล็อบบี้","一名玩家在英雄选择时离开。你已重新回到房间。":"มีผู้เล่นออกในระหว่างการเลือกแชมเปี้ยน คุณจะกลับไปเข้าคิวอีกครั้ง","对局已找到":"ได้เล่นแล้ว!","准备战斗":"เตรียมสู้ศึก","对局已接受":"ยอมรับการแข่งขันแล้ว","对局已拒绝":"ปฏิเสธการแข่งขันแล้ว","正在等待其他玩家":"กำลังรอผู้เล่นอื่น","符文页{{number}}":"หน้ารูน {{number}}","选择全部":"เลือกทั้งหมด","都不选择":"ไม่เลือกเลย","选择玩家来解除聊天黑名单，然后点击保存。":"เลือกผู้เล่นที่ต้องการปลดบล็อก แล้วคลิกที่บันทึก","按字母顺序排列":"ตามลำดับตัวอักษร","开启语言过滤器":"เปิดการกรองภาษา","启动链接警告":"เปิดใช้งานคำเตือนลิงก์","在线状态":"สถานะออนไลน์","好友列表的排列顺序：":"เรียงลำดับรายชื่อเพื่อนโดย:","启动菜单动画":"เปิดใช้งานภาพเคลื่อนไหวเมนู","启动警告弹窗":"เปิดใช้งานป๊อปอัพแจ้งเตือน","聊天黑名单":"รายชื่อที่บล็อก","聊天&好友":"พูดคุยและเพื่อน","恢复默认设置":"คืนค่าเริ่มต้น","你确定要将所有选项重置为默认设置吗？":"คุณแน่ใจว่าคุณต้องการที่จะตั้งค่าตัวเลือกทั้งหมดของคุณ ให้กลายเป็นค่าเริ่มต้น?","综合":"ทั่วไป","键位绑定":"ตั้งค่าปุ่มกด","选项":"ตัวเลือก","全部恢复默认设置":"คืนค่าเริ่มต้นทั้งหมด","声音":"เสียง","如果你的《英雄联盟》出了什么毛病，就点击下方的修复按钮来搞定它吧！警告：这个操作会耗费很长一段时间。":"ถ้ามีปัญหาบางอย่างกับการเปิด League of Legends คลิกที่ปุ่มซ่อมแซมเพื่อแก้ไขมันกันเลย! คำเตือน: มันอาจจะต้องใช้เวลานาน","你真的想要修复吗？它会耗费很长一段时间！":"คุณต้องการซ่อมแซมจริงหรือไม่? มันจำเป็นต้องใช้เวลานานนะ!","英雄选择界面的音乐音量":"ระดับเสียงเพลงหน้าเลือกแชมเปี้ยน","启动英雄选择界面的音乐":"เปิดใช้งานเสียงเพลงหน้าเลือกแชมเปี้ยน","启动登陆音乐":"เปิดใช้งานเพลงหน้าล็อกอิน","启动音效":"เปิดใช้งานเสียงเอฟเฟกต์","音效音量":"ระดับเสียงเอฟเฟกต์","关闭登录动画":"ปิดอนิเมชั่นหน้าล็อกอิน","关闭登录音效":"ปิดเพลงหน้าล็อกอิน","选择":"เลือก","传说之证 边框":"กรอบ Prestige","排位边框":"กรอบเกมจัดอันดับ","展示往届排位旗帜":"แสดงธงประจำอันดับในอดีต","无法保存。请稍后重试。":"ไม่สามารถทำการบันทึกได้ กรุณาลองใหม่ในภายหลัง","已选择":"เลือกแล้ว","当前不可用。":"ปัจจุบันไม่สามารถใช้งานได้","进行排位赛以解锁！":"เล่นเกมจัดอันดับเพื่อปลดล็อก!","保存中":"กำลังบันทึก","选择一个召唤师图标":"เลือกไอคอนซัมมอนเนอร์","召唤师图标&边框选择器":"ตัวเลือกไอคอนซัมมอนเนอร์และกรอบ","无法保存你的选择。":"การบันทึกไอคอนที่เลือกล้มเหลว","屏障":"Barrier","为你的英雄套上护盾，吸收115-455（取决于英雄等级）点伤害，持续2秒。":"สร้างโล่ป้องกันให้แชมเปี้ยนของคุณ 115-455 หน่วย (ขึ้นกับเลเวลของแชมเปี้ยน) เป็นเวลา 2 วินาที","洞察":"Clairvoyance","将地图上任意一块区域暴露给你的队伍，持续5秒。":"เปิดพื้นที่เล็ก ๆ ในแผนที่ให้ทีมของคุณเห็น เป็นเวลา 5 วินาที","清晰术":"Clarity","为你的英雄回复40%的最大法力值。也会为友军回复他们40%的最大法力值":"ฟื้นฟูมานา 40% จากค่ามานาสูงสุดของแชมเปี้ยนคุณ และช่วยฟื้นฟูมานาให้เพื่อนร่วมทีม 40% จากมานาสูงสุดของพวกเขา","净化":"Cleanse","移除身上的所有限制效果和召唤师技能的减益效果，并且若在接下来的3秒里再次被施加限制效果时，新效果的持续时间会减少65%。":"ลบสถานะผิดปกติทุกอย่างทันที และได้รับบัฟในการลดผลของสกิลหยุดที่ได้รับเข้ามาใหม่ลง 65% เป็นเวลา 3 วินาที","虚弱":"Exhaust","虚弱目标敌方英雄，降低目标英雄30%的移动速度和攻击速度，以及10护甲与魔法抗性，并且他们所造成的伤害减少40%，持续2.5秒。":"ทำให้แชมเปี้ยนเป้าหมายฝ่ายศัตรูเกิดอาการเหนื่อยล้า ส่งผลให้ความเร็วเคลื่อนที่ และความเร็วโจมตีลดลง 30% และค่าเกราะกับต้านทานเวทจะลดลง 10 หน่วย อีกทั้งยังสร้างความเสียหายได้น้อยลง 40% เป็นระยะเวลา 2.5 วินาที","闪现":"Flash","使英雄朝着你的指针所停的区域瞬间传送一小段距离。":"เทเลพอร์ตระยะสั้น ๆ ให้แชมเปี้ยนของคุณไปยังตำแหน่งที่เมาส์ของคุณชี้อยู่","卫戍部队":"Garrision","友方防御塔：提供巨量回复，持续8秒。敌方防御塔：降低伤害输出，持续8秒":"ป้อมปราการฝ่ายเรา: เพิ่มการฟื้นฟูเป็นอย่างมาก เป็นเวลา 8 วินาที ป้อมปราการฝ่ายศัตรู: ลดความเสียหายที่สร้างได้ 80% เป็นระยะเวลา 8 วินาที","幽灵疾步":"Ghost","你的英雄在移动时会无视单位的碰撞体积，移动速度增加27%，持续10秒。":"แชมเปี้ยนของคุณจะวิ่งทะลุยูนิตอื่น ๆ ได้ และเพิ่มความเร็วเคลื่อนที่ 27% เป็นเวลา 10 วินาที","治疗术":"Heal","为你和目标友军英雄回复95-345（取决于英雄等级）生命值，并为你和目标友军英雄提供30%移动速度加成，持续1秒。若目标近期已受到过其它治疗术的影响，则治疗术对目标产生的治疗效果减半。":"รักษาพลังชีวิตแชมเปี้ยนของคุณและแชมเปี้ยนเป้าหมายฝ่ายเดียวกันที่อยู่ใกล้ ๆ 90-345 หน่วย (ขึ้นอยู่กับเลเวลแชมเปี้ยน) พร้อมทั้งช่วยให้มีความเร็วเคลื่อนที่เพิ่มขึ้น 30% เป็นเวลา 1 วินาที ผลการรักษาพลังชีวิตนี้จะส่งผลเหลือเพียงครึ่งเดียว ถ้าใช้กับผู้ที่พึ่งจะได้รับผลของเวทซัมมอนเนอร์ Heal มา","引燃":"Ignite","引燃是对单体敌方目标施放的持续性伤害技能，在5秒的持续时间里造成70-410（取决于英雄等级）真实伤害，获得目标的视野，并减少目标所受的治疗和回复效果。":"สร้างความเสียหายตามจริงกับแชมเปี้ยนหนึ่งคน 70-410 หน่วย (ขึ้นอยู่กับเลเวลแชมเปี้ยนของคุณ) โดยใช้เวลาเผาไหม้ 5 วินาที และในระหว่างที่ศัตรูโดนผลนี้อยู่ ผลของฮีลและการฟื้นฟูพลังชีวิตจะลดลง","标记":"Mark","沿直线扔出一个雪球。如果雪球命中了一个敌人，那么这个敌人会被【标记】，并且你的英雄接下来可以快速突进到被【标记】的目标旁边。":"ขว้างบอลหิมะตรงออกไปใส่ศัตรูของคุณ ถ้าหากโดนตัวศัตรู จะติดเครื่องหมายไว้ที่ตัวศัตรู แล้วหลังจากนั้น แชมเปี้ยนของคุณจะสามารถเคลื่อนที่เข้าหาศัตรูได้อย่างรวดเร็ว","魄罗投掷":"Poro Toss","把一个魄罗投向你的敌人。如果它命中了一名敌人，那么你接下来就可以快速位移到被命中的敌人旁边。":"ขว้าง Poro ไปใส่ศัตรูของคุณ ถ้าหากโดนศัตรู คุณจะสามารถเคลื่อนที่เข้าหาเป้าหมายได้อย่างรวดเร็ว","重生":"Revive","立刻在本队的召唤师平台上复活你的英雄，并暂时提升英雄的移动速度。":"ชุบชีวิตแชมเปี้ยนของคุณ โดยกลับไปเกิดที่ฐานทันที และเพิ่มความเร็วเคลื่อนที่ เป็นระยะเวลาครู่หนึ่ง","惩戒":"Smite","对目标史诗野怪、大型野怪或敌方小兵造成390-1000（取决于英雄等级）点真实伤害。":"สร้างความเสียหายตามจริง 390-1,000 หน่วย (ขึ้นอยู่กับเลเวลของแชมเปี้ยน) กับมอนสเตอร์ในตำนาน มอนสเตอร์ขนาดใหญ่ หรือมินเนี่ยนฝ่ายศัตรู","传送":"Teleport","在引导3.5秒后，将英雄传送到目标友方建筑物、小兵或守卫旁边。":"หลังจากร่ายเวท 3.5 วินาที แชมเปี้ยนของคุณจะเทเลพอร์ตไปที่เป้าหมายฝ่ายเดียวกันที่เป็น มินเนี่ยน ป้อมปราการ หรือวอร์ด","护驾！":"To the King!","快速位移到魄罗之王旁边。":"เคลื่อนที่ไปหา Poro King อย่างรวดเร็ว","立刻领取":"ทันที","免费":"ฟรี","设置数量":"ระบุจำนวน","你没有足够的代币。":"คุณมี Token ไม่เพียงพอ","输入至少{{minQuantity}}个。":"ต้องใส่อย่างน้อย {{minQuantity}} ชิ้น","你只能以{{minQuantity}}的倍数来购买。":"คุณสามารถซื้อได้เป็นจำนวนทวีคูณของ {{minQuantity}} ชิ้นเท่านั้น","愚人节快乐，乐子人们！来庆祝一下吧！ ":"สุขสันต์วันโกหกนะ จอมรื่นเริง! มาฉลองกันดีกว่า!","愚人节大军需要增援，而你就是那个完美的呆萌士兵！":"กองกำลังวันโกหกเมษาต้องการกำลังเสริม และเจ้าคือทหารจอมเซ่อที่สมบูรณ์แบบที่สุด!","冲啊！我的无-羽-伦比的派对礼品就给你拿去用来对抗混乱大军吧。":"สู่สงคราม! เจ้าจะได้ครองของขวัญปาร์ตี้สุดแจ่มในสไตล์ Pengu เพื่อต่อกรกับขุมพลังแห่งความโกลาหล","在非排位的【召唤师峡谷】，【极地大乱斗】和【人机对战】里找我。我们在黎明时兜风！":"พบกับข้าได้ในเกมทั่วไปของ SR, ARAM และ Co-Op vs. AI. เราจะออกตัวกันตั้งแต่รุ่งสาง!","咕噜噜……(“你不玩吗？我可为你准备了很多愚人节惊喜……”)":"งืออ... (\"ไม่เล่นด้วยกันหน่อยเหรอ? ข้ามีเซอร์ไพรส์ในสไตล์วันโกหกเพียบเลยละเหมียว...\")","喵呜！ (“捏哈哈！有本事来抓我呀！”)":"เหมี้ยว! (\"ย๊า ฮ่า! มาจับข้าให้ได้สิเหมียว!\")","咪嗷呜！ (“混乱就是我的地盘！一场喵灾在等待！”)":"มร๊าวว! (\"ความโกลาหลนี้คืออาณาเขตของข้า! ภัยพิบัติระดับเหมียวกำลังรออยู่!\")","企鹅 盖伦":"Pengu Garen","盒子猫 萨科":"Cat-in-the-Box Shaco"};
  const patterns = [];
  try {
    window.__tr = createTextReplacer({ dict, patterns, collect: true });
  } catch (error) {
    /* 最坏情况: 什么都没发生, 客户端保持原样 */
  }
})();
