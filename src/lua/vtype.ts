import { Comment, Node } from "luaparse";
import { Diagnostic, Position, Range } from "vscode";
import { callFunc, getFunc } from "./modFunc";
import { loadNode } from "./parser";
import { getValue, LuaScope, setChild } from "./scope";
import { getBasicType, LuaAny, LuaModule, LuaNever } from "./types";
import { getItem, isArray, isObject } from "./utils";

const readonly = true;
const doc = "";

function getValueX(name: string, _g: LuaScope) {
    name = name.replace(/\s/g, "");
    let K = name.includes(".") ? name.split(".") : [ name ];
    let T = getValue(_g, K[0].trim());
    for (let i=1; i<K.length; i++) {
        T = getItem(T, [".", K[i].trim()]);
    }
    return T;
}

function getReqOfFunc(name: string, _g: LuaScope) {
    let t = getValueX(name, _g);
    if (isObject(t) && t.$$req) {
        return t.$$req;
    }
    let f = getFunc(t);
    return f && f.$argTypes && f.$argTypes[0];
}

function getResOfFunc(name: string, _g: LuaScope) {
    let t = getValueX(name, _g);
    if (isObject(t) && t.$$res) {
        return t.$$res;
    }
    let v = callFunc(t);
    return isArray(v) ? v[0] : v;
}

// 两边括号
const PairMap : { [key: string]: string} = {
    "(" : ")",
    "{" : "}",
    "<" : ">",
};

// 预解析: (小括号) {花括号}
function parseTypes(name: string, _map: Map<string, string>) {

    name = name.trim();

    if (!name.includes("(") && !name.includes("{") && !name.includes("<")) {
        return name;
    }

    let temp = [] as string[];
    let pref = "", subf = "";
    let step = 0 , pos  = 0;

    for (let i=0; i<name.length; i++) {
        let char = name[i];

        if (pref && subf) {
            if (pref === char) {            // 左边括号 ( {
                step++;
            } else if (subf === char) {     // 右边括号 ) }
                step--;
            }

            if (step === 0) {
                let str = name.substring(pos+1, i).trim();  // 不含两边括号
                let val = parseTypes(str, _map).trim();
                let key = "#T" + _map.size;

                if (pref === "<") {
                    if (!val.includes("&") && !val.includes("|")) {
                        temp.push(pref + val + subf);
                    } else {
                        _map.set(key, val);                 // 不含两边括号   #Tn : ...
                        temp.push(pref + key + subf);       // 包含两边括号  <#Tn>
                    }

                } else {
                    _map.set(key, pref + val + subf);       // 包含两边括号   #Tn : {...} 或 (...)
                    temp.push(key);                         // 不含两边括号   #Tn
                }

                pref = "";
                subf = "";
            }

        } else if (char in PairMap) {
            pref = char;
            subf = PairMap[char];
            step = 1;
            pos  = i;

        } else {
            temp.push(char);
        }

    }

    return temp.join("").trim();

}


/** 通过类型名称取得类型 */
export function loadType(name: string, _g: LuaScope, _loc?: Node["loc"], _map?: Map<string, string>): any {

    if (typeof name !== "string") { return; }

    let pos = name.indexOf("//");
    if (pos !== -1) {
        name = name.substring(0, pos);  // 去掉注释
    }

    // 基本类型
    let T = getBasicType(name);
    if (T) {return T;}

    if (!_map) {
        _map = new Map<string, string>();
        name = parseTypes(name, _map);
    }

    name = _map.get(name) || name;
    name = name.trim();
    if (!name) { return; }

    // 基本类型
    T = getBasicType(name);
    if (T) {return T;}

    // ( T )
    let m = name.match(/^\((.*)\)$/);
    if (m) {
        T = loadType(m[1], _g, _loc, _map);
        if (!isObject(T)) { return; }

        if (typeof T.type === "string" && !T.type.includes(" ")) {
            return T;
        } else {
            return { ...T, type: "(" + (T.type || m[2]) + ")" };
        }
    }

    // { K1, K2 : T2 }
    m = name.match(/^\{(.*)\}$/);
    if (m) {
        T = { type: name, doc: "", ".": {} } as any;
        let names = [] as string[];
        m[1].split(",").forEach(s => {
            let [k, t] = s.split(":");
            let n = k.trim();
            k = k.replace("?", "").trim();
            t = t && t.trim() || "string";
            if (k) {
                let v = loadType(t, _g, _loc, _map) || {};
                setChild(_g, T, ".", k, v, _loc);

                if (t !== "string" && v.type) {
                    n = n + ": " + v.type;
                }
                names.push(n);
            }
        });
        T.readonly = true;
        T.type = "{ " + names.join(", ") + " }";
        return T;
    }

    // T1 | T2 | T3
    if (name.includes("|")) {
        let names = name.split("|").map( n => n.trim() ).filter( n => !!n );
        let types = names.map( n => loadType(n, _g, _loc, _map) );
        return unionTypes(types);
    }

    // T1 & T2 & T3
    if (name.includes("&")) {
        let names = name.split("&").map( n => n.trim() ).filter( n => !!n );
        let types = names.map( n => loadType(n, _g, _loc, _map) );
        return mergeTypes(types);
    }

    // map<T> 或 arr<T>
    m = name.match(/^(map|arr)\s*<\s*(.+)\s*>$/);
    if (m) {
        T = loadType(m[2], _g, _loc, _map);
        if (!isObject(T)) { return; }
        return m[1] === "map"
            && mapType(name, T)   // map<T>
            || arrType(name, T);  // arr<T>
    }

    // req<T> 或 res<T>
    m = name.match(/^(req|res)\s*<\s*(.+)\s*>$/);
    if (m) {
        let T = m[1] === "req" ? getReqOfFunc(m[2], _g) : getResOfFunc(m[2], _g);
        if (!isObject(T)) { return; }
        return newType(name, T);
    }

    // T[] 或 T[K]
    m = name.match(/(.+)\[(.*)\]$/);
    if (m) {
        let T = loadType(m[1], _g, _loc, _map);
        if (!isObject(T)) { return; }

        let K = m[2].replace(/["']/g, "").trim();
        if (K) { // T[K]
            T = getItem(T, [".", K]) || getItem(T, [".", "*"]) || getItem(T, ["[]"]);
            return newType(name, T);
        } else {
            return arrType(name, T); // T[]
        }
    }

    // T.K
    if (name.includes(".")) {
        let K = name.split(".");
        let T = loadType(K[0].trim(), _g, _loc, _map);
        if (!isObject(T)) { return; }

        for (let i=1; i<K.length; i++) {
            T = getItem(T, [".", K[i].trim()]);
        }
        return newType(name, T);
    }

    // @T
    let namex = name.replace("@", "").trim();
    T = getBasicType(namex) || getUserType(namex, _g) || getValue(_g, namex);
    if (!isObject(T)) { return; }

    return newType(name, T);
}

// 是否基本类型
function isBasicType(typeName: string) {
    let vt: any = getBasicType(typeName);
    return vt && vt.basic;
}

// 类型是否一致
function isSameType(v1: any, v2: any) {

    if (v1 === v2) { return true; }

    let vt1: any = isObject(v1) && getBasicType(v1.type);
    let vt2: any = isObject(v2) && getBasicType(v2.type);

    return vt1 && vt2 && vt1.type === vt2.type;

}

// T1 | T2 | T3
function unionTypes(vtypes: any[]) {

    if (vtypes.length === 0) { return LuaNever; }
    if (vtypes.length === 1) { return vtypes[0]; }

    let types = [] as any[];

    vtypes.forEach(vt => {
        if (!isObject(vt)) { return; }
        if (vt.type === "never") { return; }  // 忽略 never
        if (isArray(vt.types)) {
            (vt.types as any[]).forEach( t => {
                if (!isObject(t)) { return; }
                if (t.type === "never") { return; }  // 忽略 never
                !types.includes(t) && types.push(t);
            });
        } else {
            !types.includes(vt) && types.push(vt);
        }
    });

    if (types.length === 0) { return LuaNever; }
    if (types.length === 1) {return types[0];}

    let tAny = types.find( vt => vt?.type === "any" );
    if (tAny) { return LuaAny; }

    let tInter = {} as any;         // 交集
    let tUnion = {} as any;         // 并集
    let tItems = [] as any[];       // 数组
    let tNames = [] as string[];    // 名称

    types.forEach((vt, i) => {
        if (!isObject(vt)) { return; }

        let ti = vt["."] || {};

        vt.type  && tNames.push(vt.type);
        vt["[]"] && tItems.push(vt["[]"]);

        if (i === 0) {
            tInter = { ...ti };
            tUnion = { ...ti };
        } else {
            // 并集
            tUnion = { ...ti, ...tUnion };
            for (let k in ti) {
                if (!k.startsWith("$")) {
                    if (!isSameType(tUnion[k], ti[k])) {  // 类型不一致
                        tUnion[k] = unionTypes([tUnion[k], ti[k]]);
                    }
                }
            }
            // 交集
            for (let k in tInter) {
                if (!k.startsWith("$")) {
                    if (k in ti) {
                        tInter[k] = tUnion[k];
                    } else {
                        delete tInter[k];
                        delete tInter['$' + k + '$'];
                    }
                }
            }

        }
    });

    const type  = tNames.join(" | ");
    const vtype = { type, types, readonly, doc, ".": tUnion } as any;
    const T     = { type, types, vtype, readonly, doc, ".": tInter } as any;

    if (tItems.length > 0) {
        T["[]"] = vtype["[]"] = unionTypes(tItems);
    }

    return T;

}

// T1 & T2 & T3
function mergeTypes(vtypes: any[]) : any {

    if (vtypes.length === 0) { return LuaNever; }
    if (vtypes.length === 1) { return vtypes[0]; }

    let types = [] as any[];
    let tBasic = new Map<string, boolean>();

    vtypes.forEach(vt => {
        if (!isObject(vt)) { return; }
        if (vt.type === "any") { return; }  // 忽略 any

        let typeName = vt.type || "";
        if (!types.includes(vt) && !tBasic.has(typeName)) {
            if (isBasicType(typeName)) {
                tBasic.set(typeName, true);
            }
            types.push(vt);
        }
    });

    if (types.length === 0) { return LuaAny; }
    if (types.length === 1) {return types[0];}

    // 只要有一个 never 或者基本类型的返回 never
    let tNever = types.find( vt => vt.type === "never" || vt.basic );
    if (tNever) { return LuaNever; }

    let tUnion = {} as any;         // 并集
    let tItems = [] as any[];       // 数组
    let tNames = [] as string[];    // 名称

    types.forEach((vt, i) => {
        if (!isObject(vt)) { return; }

        let ti = vt["."] || {};

        vt.type  && tNames.push(vt.type);
        vt["[]"] && tItems.push(vt["[]"]);

        if (i === 0) {
            tUnion = { ...ti };
        } else {
            // 并集
            tUnion = { ...ti, ...tUnion };
            for (let k in ti) {
                if (!k.startsWith("$")) {
                    if (!isSameType(tUnion[k], ti[k])) {  // 类型不一致
                        tUnion[k] = mergeTypes([tUnion[k], ti[k]]);
                    }
                }
            }
        }
    });

    const type  = tNames.join(" & ").replace(/\s*\}\s*&\s*\{\s*/g, ", ");
    const T     = { type, readonly, doc, ".": tUnion } as any;

    if (tItems.length > 0) {
        T["[]"] = mergeTypes(tItems);
    }

    return T;

}

function mapType(name: string, T: any) {
    T = isObject(T) ? T : { "." : {}, readonly };
    return {
        type: T.type ? `map<${ T.type }>` : name,
        readonly: true,
        doc: "",
        ".": {
            "*": T
        },
        "[]": T,
    };
}

function arrType(name: string, T: any) {
    T = isObject(T) ? T : { "." : {}, readonly };
    return {
        type: T.type ? `${ T.type }[]` : name,
        readonly: true,
        doc: "",
        "[]": T,
    };
}

function newType(name: string, T: any) {
    T = isObject(T) ? T : {};
    return (T.basic | T.readonly) && T.name ? T : {
        ... T,
        "." : { ...T["."] },
        type: name,
        readonly: (name !== "table" && name !== "object"),
        doc: "",
    };
}

function getUserType(typeName: string, _g: LuaScope) {

    let pos = typeName.indexOf("//");
    if (pos !== -1) {
        typeName = typeName.substring(0, pos);  // 去掉注释
    }

    typeName = typeName.trim();

    if (typeName.startsWith("$")) {
        // 加载 dao 类型
        let _load = getValue(_g, "_load");
        if (_load) {
            let mod: LuaModule = callFunc(_load, typeName);
            if (mod instanceof Object && mod["$dao"]) {
                let daoType = mod["$dao"];
                let daoRow = daoType["row"];
                let doc = "## "+ typeName +"\ndao 类型单行数据\n" + daoType.doc;
                return { type: typeName, doc, ".": daoRow, readonly };
            }
        }

    } else {
        // 加载自定义类型
        let $$types = getValue(_g, "$$types");
        if ($$types instanceof Object) {
            let mod: LuaModule = $$types[typeName];
            if (mod instanceof Object && mod["."] instanceof Object) {
                let userType = mod["."];
                let doc = "## "+ typeName +"\n自定义类型对象\n" + mod.doc;
                return { type: typeName, doc, ".": userType, readonly };
            }
        }
    }

}

/** 通过注释加载类型 */
export function loadTypes(node: Node, _g: LuaScope) {

    let nloc = node.loc;
    if (!nloc) {return;}

    let $$comm = getValue(_g, "$$comm");
    if (!($$comm instanceof Object)) {return;}

    let types: { [key: string]: string } = {};

    for (let i=nloc.start.line; i<=nloc.end.line; i++) {
        let comm = $$comm[i];
        if (comm instanceof Object) {
            let { name, value } = comm;
            if (name && value) {
                types[name] = value;
            }
        }
    }

    return types;

}


export function getTypeName(v: any) {

    if (!isObject(v)) {
        let t = typeof v;
        return t === "string"   ? "string"
            :  t === "number"   ? "number"
            :  t === "boolean"  ? "boolean"
            :  t === "function" ? "function"
            :  "any";
    } else {
        let t = v.type;
        return t === "string"   ? "string"
            :  t === "number"   ? "number"
            :  t === "boolean"  ? "boolean"
            :  t === "thread"   ? "thread"
            :  t === "thread"   ? "userdata"
            :  t === "thread"   ? "cdata"
            :  t === "ctype"    ? "ctype"
            :  t === "any"      ? "any"
            :  t === "never"    ? "never"
            :  v["$$mt"]        ? "table"
            :  v["()"]          ? "function"
            :  v["."]           ? "table"
            :  v[":"]           ? "table"
            :  v["[]"]          ? "table"
            :  "any";
    }
}


// 类型检查
export function check_vtype(v1: any, v2: any, n: Node, _g: LuaScope) {

    if (v1 === v2) {return;}
    if (n.isLinted) {return;}

    let lints = getValue(_g, "$$lints");
    if(!lints) {return;}

    if (!isObject(v1) || !v1.type) { return; }
    if (v1?.type === v2?.type) {return;}

    let vt1 = getTypeName(v1);
    if (vt1 === "any") {return;}

    let vt2 = getTypeName(v2);
    if (vt2 === "any") {return;}

    if (vt1 === "never" || vt2 === "never") {
        addLint(n, "", _g, `不能将类型 “${ vt2 }” 分配给类型 “${ vt1 }”`);
    }

    // if (vt1 === vt2) {return;}

    let at1 : string[] = isArray(v1.types) ? v1.types.map(getTypeName) : [vt1];
    let at2 : string[] = isArray(v2.types) ? v2.types.map(getTypeName) : [vt2];

    if (at1.some(t => t === "any" || at2.includes(t) )) {
        return;
    }

    if (at2.some(t => t === "any" )) {
        return;
    }

    vt1 = v1?.type || vt1; //at1.join(" | ");
    vt2 = v2?.type || vt2; //at2.join(" | ");

    addLint(n, "", _g, `不能将类型 “${ vt2 }” 分配给类型 “${ vt1 }”`);

}


// 为 apicheck 提供成员字段检查
export function addLint(n: Node, k: string, _g: LuaScope, message?: string) {

    if (k.startsWith("_")) {return;}

    let lints = getValue(_g, "$$lints") as Diagnostic[];
    if(!lints) {return;}

    if (n.isLinted) {return;}
        n.isLinted = true;

    let start = n.loc!.start;
    let end   = n.loc!.end;

    message = message || `成员字段 “${ k }” 不存在或属性未定义`;

    lints.push({
        range: new Range(
            new Position(start.line-1, start.column),
            new Position(end.line-1, end.column)
        ),
        message,
        severity: 1,
    });

}

type CommentMap = { [key: number] : { name: string, loc: Node["loc"]  } };

// 取得行内类型声明
export function get_vtype_inline(n: Node, _g: LuaScope): any {

    let comments = getValue(_g, "$$comments") as Comment[];
    if (!comments) {return;}

    let map = (comments as any)["$$map"] as CommentMap;
    if (!map) {
        map = (comments as any)["$$map"] = {};
        comments.forEach(c => {
            let line = c.loc!.start.line;
            let name = c.raw;
            if (name.startsWith("-->")) {
                map[line] = {
                    name : name.substring(3).trim(),
                    loc  : c.loc
                };
            }
        });
    }

    let c = map[n.loc!.start.line];
    if (!c) {return;}

    return loadType(c.name, _g, c.loc);

}

// 获取参数类型
export function get_vtype(n: Node, _g: LuaScope) {

    let vtype : any;

    if (n.type === "Identifier") {
        vtype = getValue(_g, n.name);

    } else if (n.type === "MemberExpression") {
        let t = loadNode(n.base, _g);
        if (isArray(t)) { t = t[0]; }
        if (!isObject(t) || t["type"] === "any") { return; }

        let ti = t["."] || {};
        let k = n.identifier.name;

        if (k in ti) {
            vtype = ti[k];
        } else if ("*" in ti) {
            vtype = ti["*"];
        } else if (t.readonly) {
            addLint(n.identifier, k, _g);
        }

    } else if (n.type === "IndexExpression") {
        let t = loadNode(n.base, _g);
        if (isArray(t)) { t = t[0]; }
        if (!isObject(t) || t["type"] === "any") { return; }

        let k = loadNode(n.index, _g);
        let vt = getTypeName(k);

        if (typeof k === "number") {
            vtype = getItem(t, [".", String(k)]) || getItem(t, ["[]"]) || getItem(t, [".", "*"]);
        } else if (typeof k === "string") {
            vtype = getItem(t, [".", k]) || getItem(t, [".", "*"]);
        } else if (vt === "number") {
            vtype = getItem(t, ["[]"]) || getItem(t, [".", "*"]);
        } else if (vt === "string") {
            vtype = getItem(t, [".", "*"]);
        }

    } else {
        let t = loadNode(n, _g);
        if (isArray(t)) { t = t[0]; }
        vtype = t;
    }

    // 只读的自定义类型
    if (isObject(vtype) && vtype.readonly && vtype["type"] !== "any") {
        return vtype?.vtype ? vtype?.vtype : vtype;
    }

}

const $dao_ext = {
    _order_by : { doc: "## _order_by \n\n `< string >` \n\n ### 排序 \n\n" },
    _group_by : { doc: "## _group_by \n\n `< string >` \n\n ### 汇总 \n\n" },
    _limit    : { doc: "## _limit    \n\n `< number | string >` \n\n ### 记录数 \n\n" },
};

// 设置形参类型
export function set_vtype(funt: any, arg: Node, _g: LuaScope, args: Node[] = [], i = 0) {

    if (typeof funt !== "object") {return;}

    const isTable = arg.type === "TableConstructorExpression";
    // if (arg.type !== "TableConstructorExpression") {return;}

    // table.insert( arr, {} )  根据第一个参数 arr 的类型推导最后一个参数的类型
    if (funt.doc?.startsWith("table.insert") && args.length >= 2 && i === args.length-1) {
        let vtype = get_vtype(args[0], _g);
        if (vtype && vtype["[]"]) {
            let vt = vtype["[]"];
            arg.vtype = isTable && vt?.vtype ? vt?.vtype : vt;
            return;
        }
    }

    if (i===0 && isObject(funt.$$req)) {
        // api 请求参数字段
        let vt = funt.$$req;
        arg.vtype = isTable && vt?.vtype ? vt?.vtype : vt;

    } else if (i===0 && isObject(funt.$dao) && isObject(funt.$dao.row)) {
        // dao 对象参数字段
        const row = funt.$dao.row;
        const doc = funt.doc || "" as string;

        if (/dao[:.](get|list)/g.test(doc)) {
            arg.vtype = {
                ["." ] : { ...row, ...$dao_ext },
                ["[]"] : { ".": {} },
            };
        }else if (/dao[:.](add|set)/g.test(doc)) {
            arg.vtype = {
                ["." ] : row,
                ["[]"] : { ".": row },
            };
        } else {
            arg.vtype = {
                ["." ] : row,
                ["[]"] : { ".": {} },
            };
        }

    } else {
        // 自定义类型参数字段
        let func = getItem(funt, ["()"]);
        if (func) {
            if (func.$argTypes) {
                let vt = func.$argTypes[i];
                arg.vtype = isTable && vt?.vtype ? vt?.vtype : vt;
            }
            return;
        }

        // 元表 __call 方法
        func = getItem(funt, ["$$mt", ".", "__call", "()"]);
        if (func) {
            if (func.$argTypes) {
                let vt = func.$argTypes[i+1];  //参数向后位移一位哦！！
                arg.vtype = isTable && vt?.vtype ? vt?.vtype : vt;
            }
        }
    }

}
