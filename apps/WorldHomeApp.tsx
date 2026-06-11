/**
 * 「家园」—— 同世界观多角色共同生活的大世界。
 *
 * 三个视图：
 *   - list：世界列表 + 新建
 *   - edit：世界编辑器（世界观/模式/成员/居住安排/NPC/关系/离线 tick/API 覆盖）
 *   - world：大世界主视图（观测推进、拜访各家、关系条、NPC 动静、时间线）
 *
 * 视觉：游戏化——天空随剧情时间昼夜切换（白天暖阳/夜晚星空），小屋是带屋顶的
 * 村庄卡片，角色手机用真手机壳弹窗呈现（动态=信息流、私信=聊天气泡）。
 *
 * 演绎引擎跑在 OSContext 全局（WorldScheduler.onTrigger → runWorldEpisode），
 * 本组件只负责触发与观察——用户点完"观测"就算切去和别人私聊，演绎照样完成。
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import {
    ArrowLeft, Plus, GearSix, Trash, House, UsersThree,
    CaretRight, CaretDown, Sparkle, MapPin, DeviceMobile, X,
    MoonStars, SunHorizon, Heart, ChatCircleDots, Article, WifiHigh, BatteryFull, CellSignalFull,
} from '@phosphor-icons/react';
import { DB } from '../utils/db';
import { getChibi } from '../utils/vrWorld/chibi';
import { WorldScheduler, WorldTickSlot } from '../utils/worldHome/scheduler';
import { isWorldRunning } from '../utils/worldHome/engine';
import { storyTimeLabel, houseOf } from '../utils/worldHome/prompts';
import type { WorldProfile, WorldEpisode, WorldHomeMode, WorldHouse, CharacterProfile, WorldCharBeat } from '../types';

const genId = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const MODE_INFO: Record<WorldHomeMode, { name: string; short: string; desc: string; badge: string }> = {
    light: { name: '轻度 · 以你为主', short: '以你为主', desc: '只是观察角色生活的一个切面。世界里 ta 依旧以你为最重要的人——和聊天里完全一致。', badge: 'bg-sky-400/90 text-sky-950' },
    medium: { name: '中度 · 你是一份子', short: '你是一份子', desc: '你是这个世界的普通一员，存在但不特殊，角色不围着你转。', badge: 'bg-amber-400/90 text-amber-950' },
    heavy: { name: '重度 · 无你世界', short: '无你世界', desc: '你不存在（或只是透明的幽灵）。角色之间自行生活，演绎中完全无视你。', badge: 'bg-rose-400/90 text-rose-950' },
};

const TICK_SLOT_INFO: { id: WorldTickSlot; label: string }[] = [
    { id: 'morning', label: '早（9点后）' },
    { id: 'noon', label: '午（14点后）' },
    { id: 'evening', label: '晚（21点后）' },
];

/** 全局动画 keyframes（云朵漂浮 / 星星闪烁 / 微光扫过）。 */
const GameStyles: React.FC = () => (
    <style>{`
        @keyframes wh-drift { 0% { transform: translateX(0); } 50% { transform: translateX(14px); } 100% { transform: translateX(0); } }
        @keyframes wh-twinkle { 0%, 100% { opacity: .9; } 50% { opacity: .25; } }
        @keyframes wh-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
        @keyframes wh-sheen { 0% { transform: translateX(-150%) skewX(-20deg); } 100% { transform: translateX(250%) skewX(-20deg); } }
        .wh-sheen::after { content: ''; position: absolute; top: 0; bottom: 0; width: 40%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent);
            animation: wh-sheen 2.8s ease-in-out infinite; }
    `}</style>
);

/** 夜空星星（纯 CSS，多层 radial-gradient）。 */
const starsBg = `radial-gradient(1.5px 1.5px at 12% 28%, #fff, transparent),
radial-gradient(1px 1px at 28% 62%, #ffeebb, transparent),
radial-gradient(1.5px 1.5px at 44% 18%, #fff, transparent),
radial-gradient(1px 1px at 58% 48%, #cfe2ff, transparent),
radial-gradient(2px 2px at 72% 24%, #fff, transparent),
radial-gradient(1px 1px at 84% 56%, #ffeebb, transparent),
radial-gradient(1.5px 1.5px at 92% 32%, #fff, transparent)`;

/** Q版小人（彼方捏人系统的 chibi，兜底头像）。 */
const ChibiFigure: React.FC<{ char: CharacterProfile; size?: number; bob?: boolean }> = ({ char, size = 56, bob }) => {
    const c = getChibi(char);
    if (!c.img) {
        return <div className="rounded-full bg-emerald-200/60 flex items-center justify-center text-emerald-800 font-bold" style={{ width: size, height: size }}>{char.name.slice(0, 1)}</div>;
    }
    return (
        <div className="flex flex-col items-center" style={{ width: size, animation: bob ? 'wh-bob 2.6s ease-in-out infinite' : undefined }}>
            <img
                src={c.img}
                alt={char.name}
                className={c.isFallback ? 'rounded-full object-cover' : 'object-contain'}
                style={{
                    width: size, height: size,
                    transform: `${c.flip ? 'scaleX(-1) ' : ''}scale(${c.isFallback ? 1 : c.scale})`,
                    transformOrigin: 'bottom center',
                    filter: 'drop-shadow(0 5px 6px rgba(0,0,0,.30))',
                }}
                draggable={false}
            />
        </div>
    );
};

// ============================================================
// 真手机弹窗：角色这半天的手机（动态=信息流，私信=聊天气泡）
// ============================================================
const PhoneModal: React.FC<{
    beat: WorldCharBeat;
    char?: CharacterProfile;
    storyTime: string;
    onClose: () => void;
}> = ({ beat, char, storyTime, onClose }) => {
    const [tab, setTab] = useState<'feed' | 'dm'>('feed');
    const posts = beat.phone?.posts || [];
    const dms = beat.phone?.dms || [];
    const avatar = char?.avatar;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div className="relative" onClick={e => e.stopPropagation()}>
                {/* 手机壳 */}
                <div className="w-[272px] h-[548px] rounded-[2.6rem] bg-gradient-to-b from-zinc-800 to-zinc-950 p-[7px] shadow-[0_24px_60px_rgba(0,0,0,.6),inset_0_1px_1px_rgba(255,255,255,.18)]">
                    <div className="relative w-full h-full rounded-[2.15rem] overflow-hidden flex flex-col" style={{ background: 'linear-gradient(170deg,#101426 0%,#1b2138 60%,#232a47 100%)' }}>
                        {/* 灵动岛 */}
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 w-20 h-[18px] rounded-full bg-black z-20" />
                        {/* 状态栏 */}
                        <div className="pt-2.5 pb-1 px-5 flex items-center justify-between text-[9px] text-white/80 font-semibold shrink-0">
                            <span>{storyTime}</span>
                            <span className="flex items-center gap-1"><CellSignalFull size={10} weight="fill" /><WifiHigh size={10} weight="bold" /><BatteryFull size={12} weight="fill" /></span>
                        </div>
                        {/* 机主栏 */}
                        <div className="px-4 pt-2 pb-3 flex items-center gap-2.5 shrink-0">
                            {avatar
                                ? <img src={avatar} className="w-9 h-9 rounded-2xl object-cover ring-2 ring-white/20" alt="" />
                                : <div className="w-9 h-9 rounded-2xl bg-white/15 flex items-center justify-center text-white font-bold">{beat.charName.slice(0, 1)}</div>}
                            <div className="min-w-0">
                                <div className="text-[13px] font-bold text-white truncate">{beat.charName} 的手机</div>
                                <div className="text-[9.5px] text-white/50">{beat.location} · {beat.mood}</div>
                            </div>
                            <button onClick={onClose} className="ml-auto p-1.5 rounded-full bg-white/10 text-white/70 active:scale-90"><X size={13} weight="bold" /></button>
                        </div>
                        {/* Tab */}
                        <div className="px-4 flex gap-1.5 shrink-0">
                            {([['feed', '动态', Article], ['dm', '私信', ChatCircleDots]] as const).map(([id, label, Icon]) => (
                                <button key={id} onClick={() => setTab(id)}
                                    className={`flex-1 py-1.5 rounded-xl text-[11px] font-bold flex items-center justify-center gap-1 transition-colors ${tab === id ? 'bg-white text-slate-900' : 'bg-white/10 text-white/60'}`}>
                                    <Icon size={12} weight="bold" />{label}
                                    <span className={`text-[8.5px] px-1 rounded-full ${tab === id ? 'bg-slate-900/10' : 'bg-white/10'}`}>{id === 'feed' ? posts.length : dms.length}</span>
                                </button>
                            ))}
                        </div>
                        {/* 内容 */}
                        <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-2.5">
                            {tab === 'feed' && (
                                posts.length === 0
                                    ? <div className="text-center text-[11px] text-white/40 pt-16">这半天没发动态</div>
                                    : posts.map((p, i) => (
                                        <div key={i} className="rounded-2xl bg-white/95 p-3 shadow-sm">
                                            <div className="flex items-center gap-2">
                                                {avatar
                                                    ? <img src={avatar} className="w-6 h-6 rounded-full object-cover" alt="" />
                                                    : <div className="w-6 h-6 rounded-full bg-slate-200 flex items-center justify-center text-[10px] font-bold text-slate-600">{beat.charName.slice(0, 1)}</div>}
                                                <div>
                                                    <div className="text-[10.5px] font-bold text-slate-800 leading-none">{beat.charName}</div>
                                                    <div className="text-[8.5px] text-slate-400 mt-0.5">{storyTime} · 来自{beat.location}</div>
                                                </div>
                                            </div>
                                            <p className="text-[11.5px] leading-[1.6] text-slate-700 mt-2 whitespace-pre-wrap">{p}</p>
                                            <div className="mt-2 pt-1.5 border-t border-slate-100 flex items-center gap-3 text-slate-400">
                                                <span className="flex items-center gap-0.5 text-[9px]"><Heart size={11} /> 喜欢</span>
                                                <span className="flex items-center gap-0.5 text-[9px]"><ChatCircleDots size={11} /> 评论</span>
                                            </div>
                                        </div>
                                    ))
                            )}
                            {tab === 'dm' && (
                                dms.length === 0
                                    ? <div className="text-center text-[11px] text-white/40 pt-16">这半天没给谁发消息</div>
                                    : dms.map((d, i) => (
                                        <div key={i} className="rounded-2xl bg-white/95 overflow-hidden shadow-sm">
                                            <div className="px-3 py-1.5 bg-slate-100/90 text-[10px] font-bold text-slate-600 flex items-center gap-1">
                                                <ChatCircleDots size={11} weight="bold" />发给 {d.to}
                                            </div>
                                            <div className="p-2.5 space-y-1.5">
                                                {d.lines.map((l, j) => (
                                                    <div key={j} className="flex justify-end">
                                                        <div className="max-w-[85%] px-2.5 py-1.5 rounded-2xl rounded-br-md bg-gradient-to-br from-emerald-400 to-emerald-500 text-white text-[11px] leading-snug shadow-sm">
                                                            {l}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ))
                            )}
                        </div>
                        {/* home indicator */}
                        <div className="pb-2 pt-1 flex justify-center shrink-0"><div className="w-24 h-1 rounded-full bg-white/30" /></div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================
// 编辑器
// ============================================================
const WorldEditor: React.FC<{
    draft: WorldProfile;
    characters: CharacterProfile[];
    onSave: (w: WorldProfile) => void;
    onCancel: () => void;
    onDelete?: () => void;
}> = ({ draft, characters, onSave, onCancel, onDelete }) => {
    const [w, setW] = useState<WorldProfile>(draft);
    const upd = (updates: Partial<WorldProfile>) => setW(prev => ({ ...prev, ...updates }));
    const members = useMemo(() => w.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[], [w.memberIds, characters]);

    const toggleMember = (id: string) => {
        if (w.memberIds.includes(id)) {
            upd({
                memberIds: w.memberIds.filter(m => m !== id),
                houses: w.houses.map(h => ({ ...h, residentIds: h.residentIds.filter(r => r !== id) })),
                relationships: w.relationships.filter(r => r.fromId !== id && r.toId !== id),
            });
        } else {
            upd({ memberIds: [...w.memberIds, id] });
        }
    };

    const toggleResident = (houseId: string, charId: string) => {
        upd({
            houses: w.houses.map(h => {
                if (h.id !== houseId) return { ...h, residentIds: h.residentIds.filter(r => r !== charId) };
                return h.residentIds.includes(charId)
                    ? { ...h, residentIds: h.residentIds.filter(r => r !== charId) }
                    : { ...h, residentIds: [...h.residentIds, charId] };
            }),
        });
    };

    // 成员两两关系（编辑用：每对展开成 A→B 和 B→A 两条有向边，可以不对等）
    const pairs = useMemo(() => {
        const out: { aId: string; bId: string; aName: string; bName: string }[] = [];
        for (let i = 0; i < members.length; i++) {
            for (let j = i + 1; j < members.length; j++) {
                out.push({ aId: members[i].id, bId: members[j].id, aName: members[i].name, bName: members[j].name });
            }
        }
        return out;
    }, [members]);

    const relOf = (fromId: string, toId: string) => w.relationships.find(r => r.fromId === fromId && r.toId === toId);
    const updRel = (fromId: string, toId: string, updates: { label?: string; value?: number }) => {
        const existing = relOf(fromId, toId);
        if (existing) {
            upd({ relationships: w.relationships.map(r => (r.fromId === fromId && r.toId === toId) ? { ...r, ...updates } : r) });
        } else {
            upd({ relationships: [...w.relationships, { fromId, toId, value: 50, ...updates }] });
        }
    };

    const inputCls = 'w-full px-3 py-2 rounded-xl bg-white/90 border border-stone-200 text-sm text-stone-800 focus:outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200/50 transition-shadow';
    const sectionCls = 'bg-white/80 backdrop-blur rounded-2xl p-4 border border-stone-200/80 shadow-[0_2px_12px_rgba(60,50,30,.06)] space-y-2.5';
    const labelCls = 'text-[10.5px] font-black text-stone-500 tracking-[0.12em] uppercase';

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-28 pt-3 space-y-3">
            <div className={sectionCls}>
                <div className={labelCls}>世界名字</div>
                <input className={inputCls} value={w.name} onChange={e => upd({ name: e.target.value })} placeholder="比如：栗子镇" />
                <div className={labelCls}>世界观（这个世界是什么样的、大家以什么身份生活）</div>
                <textarea className={`${inputCls} h-28 resize-none`} value={w.worldview} onChange={e => upd({ worldview: e.target.value })}
                    placeholder="一个海边小镇，大家是多年的老邻居。镇上有一家面包店和一座旧灯塔……" />
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>模式（你在这个世界里的存在感）</div>
                {(Object.keys(MODE_INFO) as WorldHomeMode[]).map(m => (
                    <button key={m} onClick={() => upd({ mode: m })}
                        className={`w-full text-left px-3.5 py-2.5 rounded-xl border transition-all ${w.mode === m ? 'bg-stone-900 border-stone-900 text-white shadow-lg' : 'bg-white border-stone-200 text-stone-700'}`}>
                        <div className="text-[12px] font-bold flex items-center gap-2">
                            {MODE_INFO[m].name}
                            {w.mode === m && <span className={`text-[8.5px] px-1.5 py-0.5 rounded-full font-black ${MODE_INFO[m].badge}`}>已选</span>}
                        </div>
                        <div className={`text-[10.5px] mt-0.5 leading-snug ${w.mode === m ? 'text-white/70' : 'text-stone-500'}`}>{MODE_INFO[m].desc}</div>
                    </button>
                ))}
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>住进这个世界的角色（同一世界观的放一起）</div>
                <div className="flex flex-wrap gap-2">
                    {characters.map(c => (
                        <button key={c.id} onClick={() => toggleMember(c.id)}
                            className={`flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border transition-all ${w.memberIds.includes(c.id) ? 'bg-stone-900 border-stone-900 text-white shadow-md' : 'bg-white border-stone-200 text-stone-700'}`}>
                            <img src={c.avatar} className="w-6 h-6 rounded-full object-cover" alt="" />
                            <span className="text-[12px] font-semibold">{c.name}</span>
                        </button>
                    ))}
                </div>
                {characters.length === 0 && <div className="text-[11px] text-stone-400">还没有角色，先去「神经链接」创建</div>}
            </div>

            <div className={sectionCls}>
                <div className="flex items-center justify-between">
                    <div className={labelCls}>居住安排（没分进小屋的成员独居）</div>
                    <button onClick={() => upd({ houses: [...w.houses, { id: genId('wh'), name: `小屋 ${w.houses.length + 1}`, residentIds: [] }] })}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 font-bold flex items-center gap-1 border border-amber-200"><Plus size={12} weight="bold" />同居小屋</button>
                </div>
                {w.houses.map(h => (
                    <div key={h.id} className="rounded-xl border border-stone-200 bg-white p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                            <House size={14} className="text-amber-600 shrink-0" weight="fill" />
                            <input className="flex-1 px-2 py-1 rounded-lg bg-stone-50 border border-stone-100 text-[12px]" value={h.name}
                                onChange={e => upd({ houses: w.houses.map(x => x.id === h.id ? { ...x, name: e.target.value } : x) })} />
                            <button onClick={() => upd({ houses: w.houses.filter(x => x.id !== h.id) })} className="p-1 text-stone-400"><X size={14} /></button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {members.map(m => (
                                <button key={m.id} onClick={() => toggleResident(h.id, m.id)}
                                    className={`text-[11px] px-2 py-0.5 rounded-full border ${h.residentIds.includes(m.id) ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-stone-200 text-stone-600'}`}>
                                    {m.name}
                                </button>
                            ))}
                            {members.length === 0 && <span className="text-[10px] text-stone-400">先在上面选成员</span>}
                        </div>
                    </div>
                ))}
            </div>

            <div className={sectionCls}>
                <div className="flex items-center justify-between">
                    <div className={labelCls}>NPC（无记忆，纯为世界观服务，一次调用全演完）</div>
                    <button onClick={() => upd({ npcs: [...w.npcs, { id: genId('npc'), name: '', persona: '', emoji: '🙂' }] })}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-100 text-amber-800 font-bold flex items-center gap-1 border border-amber-200"><Plus size={12} weight="bold" />NPC</button>
                </div>
                {w.npcs.map(n => (
                    <div key={n.id} className="rounded-xl border border-stone-200 bg-white p-2.5 space-y-1.5">
                        <div className="flex items-center gap-2">
                            <input className="w-10 px-1 py-1 rounded-lg bg-stone-50 border border-stone-100 text-center text-[14px]" value={n.emoji || ''} maxLength={2}
                                onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, emoji: e.target.value } : x) })} />
                            <input className="flex-1 px-2 py-1 rounded-lg bg-stone-50 border border-stone-100 text-[12px]" value={n.name} placeholder="名字"
                                onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, name: e.target.value } : x) })} />
                            <button onClick={() => upd({ npcs: w.npcs.filter(x => x.id !== n.id) })} className="p-1 text-stone-400"><X size={14} /></button>
                        </div>
                        <input className="w-full px-2 py-1 rounded-lg bg-stone-50 border border-stone-100 text-[12px]" value={n.persona} placeholder="一句话人设（面包店老板娘，热心肠爱塞吃的）"
                            onChange={e => upd({ npcs: w.npcs.map(x => x.id === n.id ? { ...x, persona: e.target.value } : x) })} />
                    </div>
                ))}
            </div>

            {pairs.length > 0 && (
                <div className={sectionCls}>
                    <div className={labelCls}>初始关系（有向：两边可以不对等，比如单恋/单方面死对头；演绎会各自调整）</div>
                    {pairs.map(p => (
                        <div key={`${p.aId}_${p.bId}`} className="rounded-xl border border-stone-200 bg-white p-2.5 space-y-2.5">
                            {([[p.aId, p.bId, p.aName, p.bName], [p.bId, p.aId, p.bName, p.aName]] as const).map(([fromId, toId, fromName, toName]) => {
                                const rel = relOf(fromId, toId);
                                return (
                                    <div key={`${fromId}_${toId}`} className="space-y-1.5">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[12px] font-bold text-stone-700 shrink-0">{fromName} → {toName}</span>
                                            <input className="flex-1 min-w-0 px-2 py-0.5 rounded-lg bg-stone-50 border border-stone-100 text-[11px]" placeholder={`${fromName} 眼中的关系（挚友/单恋/死对头…）`}
                                                value={rel?.label || ''} onChange={e => updRel(fromId, toId, { label: e.target.value })} />
                                            <span className="text-[11px] text-amber-700 font-bold w-7 text-right">{rel?.value ?? 50}</span>
                                        </div>
                                        <input type="range" min={0} max={100} value={rel?.value ?? 50} className="w-full accent-amber-500"
                                            onChange={e => updRel(fromId, toId, { value: parseInt(e.target.value, 10) })} />
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            )}

            <div className={sectionCls}>
                <div className={labelCls}>离线 tick（不开 App 世界也慢慢走；每个时段当天最多一轮，链式调用 N 个角色比较贵）</div>
                <div className="flex gap-2">
                    {TICK_SLOT_INFO.map(s => {
                        const on = (w.offlineTickSlots || []).includes(s.id);
                        return (
                            <button key={s.id} onClick={() => upd({ offlineTickSlots: on ? (w.offlineTickSlots || []).filter(x => x !== s.id) : [...(w.offlineTickSlots || []), s.id] })}
                                className={`flex-1 text-[11px] py-1.5 rounded-xl border font-bold transition-all ${on ? 'bg-stone-900 border-stone-900 text-white shadow-md' : 'bg-white border-stone-200 text-stone-600'}`}>
                                {s.label}
                            </button>
                        );
                    })}
                </div>
                <label className="flex items-center justify-between pt-1">
                    <span className="text-[12px] text-stone-700">生成内容注入聊天（world_card，进上下文与记忆）</span>
                    <input type="checkbox" checked={w.injectToChat !== false} onChange={e => upd({ injectToChat: e.target.checked })} className="w-4 h-4 accent-amber-500" />
                </label>
            </div>

            <div className={sectionCls}>
                <div className={labelCls}>独立 API 覆盖（可选，不填用全局）</div>
                <input className={inputCls} placeholder="Base URL" value={w.api?.baseUrl || ''}
                    onChange={e => upd({ api: { baseUrl: e.target.value, apiKey: w.api?.apiKey || '', model: w.api?.model || '' } })} />
                <input className={inputCls} placeholder="API Key" type="password" value={w.api?.apiKey || ''}
                    onChange={e => upd({ api: { baseUrl: w.api?.baseUrl || '', apiKey: e.target.value, model: w.api?.model || '' } })} />
                <input className={inputCls} placeholder="Model" value={w.api?.model || ''}
                    onChange={e => upd({ api: { baseUrl: w.api?.baseUrl || '', apiKey: w.api?.apiKey || '', model: e.target.value } })} />
            </div>

            {onDelete && (
                <button onClick={onDelete} className="w-full py-2.5 rounded-2xl border border-red-200 bg-white/70 text-red-500 text-[12px] font-bold flex items-center justify-center gap-1.5">
                    <Trash size={14} weight="bold" />删除这个世界（连同演绎历史）
                </button>
            )}

            <div className="fixed bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-[#f3eee3] via-[#f3eee3]/95 to-transparent flex gap-2.5 max-w-md mx-auto">
                <button onClick={onCancel} className="flex-1 py-2.5 rounded-2xl bg-white border border-stone-200 text-stone-600 text-[13px] font-bold shadow-sm">取消</button>
                <button
                    onClick={() => {
                        const cleaned: WorldProfile = {
                            ...w,
                            name: w.name.trim() || '未命名世界',
                            npcs: w.npcs.filter(n => n.name.trim()),
                            api: w.api?.baseUrl?.trim() ? w.api : undefined,
                            updatedAt: Date.now(),
                        };
                        onSave(cleaned);
                    }}
                    disabled={w.memberIds.length === 0}
                    className="flex-[2] py-2.5 rounded-2xl bg-stone-900 text-white text-[13px] font-bold disabled:opacity-40 shadow-lg">
                    保存世界
                </button>
            </div>
        </div>
    );
};

// ============================================================
// 大世界视图
// ============================================================
const WorldView: React.FC<{
    world: WorldProfile;
    characters: CharacterProfile[];
    onEdit: () => void;
    onWorldUpdated: () => void;
}> = ({ world, characters, onEdit, onWorldUpdated }) => {
    const { addToast } = useOS();
    const [episodes, setEpisodes] = useState<WorldEpisode[]>([]);
    const [progress, setProgress] = useState<{ done: number; total: number; charName?: string } | null>(
        isWorldRunning(world.id) ? { done: 0, total: world.memberIds.length } : null
    );
    const [openHouseId, setOpenHouseId] = useState<string | null>(null);
    const [openEpisodeId, setOpenEpisodeId] = useState<string | null>(null);
    const [phoneBeat, setPhoneBeat] = useState<WorldCharBeat | null>(null);

    const members = useMemo(() => world.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[], [world.memberIds, characters]);
    const latest = episodes[0];
    // 氛围跟随"即将到来的半天"：偶数=白天，奇数=夜晚
    const isNight = world.storyClock % 2 === 1;

    const loadEpisodes = useCallback(async () => {
        setEpisodes(await DB.getWorldEpisodes(world.id, 30));
    }, [world.id]);

    useEffect(() => { loadEpisodes(); }, [loadEpisodes]);

    useEffect(() => {
        const onStart = (e: any) => { if (e.detail?.worldId === world.id) setProgress({ done: 0, total: e.detail.total || members.length }); };
        const onBeat = (e: any) => { if (e.detail?.worldId === world.id) setProgress({ done: e.detail.done || 0, total: e.detail.total || members.length, charName: e.detail.charName }); };
        const onDone = (e: any) => { if (e.detail?.worldId === world.id) { loadEpisodes(); onWorldUpdated(); } };
        const onEnd = (e: any) => { if (e.detail?.worldId === world.id) setProgress(null); };
        window.addEventListener('world-episode-start', onStart);
        window.addEventListener('world-beat-done', onBeat);
        window.addEventListener('world-episode-done', onDone);
        window.addEventListener('world-episode-end', onEnd);
        return () => {
            window.removeEventListener('world-episode-start', onStart);
            window.removeEventListener('world-beat-done', onBeat);
            window.removeEventListener('world-episode-done', onDone);
            window.removeEventListener('world-episode-end', onEnd);
        };
    }, [world.id, members.length, loadEpisodes, onWorldUpdated]);

    const observe = () => {
        if (isWorldRunning(world.id)) { addToast('这一轮还在演绎中', 'error'); return; }
        if (members.length === 0) { addToast('这个世界还没有住进角色', 'error'); return; }
        setProgress({ done: 0, total: members.length });
        WorldScheduler.triggerNow(world.id);
        addToast('观测开始——世界推进半天，可以先去做别的', 'success');
    };

    // 拜访视图的住房编排：配置的小屋 + 没分配的成员各自独居
    const visitHouses = useMemo(() => {
        const out: { house: WorldHouse; residents: CharacterProfile[] }[] = [];
        for (const h of world.houses) {
            const residents = h.residentIds.map(id => members.find(m => m.id === id)).filter(Boolean) as CharacterProfile[];
            if (residents.length > 0) out.push({ house: h, residents });
        }
        for (const m of members) {
            if (!houseOf(world, m.id)) out.push({ house: { id: `solo_${m.id}`, name: `${m.name} 的小屋`, residentIds: [m.id] }, residents: [m] });
        }
        return out;
    }, [world, members]);

    const beatOf = (charId: string): WorldCharBeat | undefined => latest?.beats.find(b => b.charId === charId);
    const nameOf = (id: string) => members.find(m => m.id === id)?.name || world.npcs.find(n => n.id === id)?.name || '?';

    // 主题 token：昼/夜两套
    const t = isNight ? {
        pageBg: 'linear-gradient(180deg,#11142a 0%,#171b35 30%,#1b2038 100%)',
        skyBg: 'linear-gradient(180deg,#0e1130 0%,#23284f 70%,#3b3866 100%)',
        panel: 'bg-white/[0.07] border-white/10 backdrop-blur',
        panelSolid: 'bg-[#1f2440]/90 border-white/10',
        textMain: 'text-indigo-50',
        textSub: 'text-indigo-200/60',
        textLabel: 'text-indigo-200/70',
        chip: 'bg-white/10 border-white/10 text-indigo-100',
        divider: 'border-white/10',
        roofBg: 'linear-gradient(135deg,#4a3f63 0%,#37304e 100%)',
        lawnBg: 'linear-gradient(180deg,#1d3a33 0%,#16261f 100%)',
        barTrack: 'bg-white/10',
    } : {
        pageBg: 'linear-gradient(180deg,#cfe7da 0%,#ecf2e2 22%,#f5f1e3 100%)',
        skyBg: 'linear-gradient(180deg,#79b8e3 0%,#a8d4e8 55%,#d8ecd9 100%)',
        panel: 'bg-white/75 border-white/70 backdrop-blur shadow-[0_3px_14px_rgba(70,90,60,.08)]',
        panelSolid: 'bg-white/90 border-stone-200/70',
        textMain: 'text-stone-800',
        textSub: 'text-stone-500',
        textLabel: 'text-stone-500',
        chip: 'bg-white/80 border-stone-200 text-stone-700',
        divider: 'border-stone-200/70',
        roofBg: 'linear-gradient(135deg,#c97a55 0%,#a85b3d 100%)',
        lawnBg: 'linear-gradient(180deg,#9ecf8e 0%,#7db86f 100%)',
        barTrack: 'bg-stone-200/80',
    };

    return (
        <div className="flex-1 overflow-y-auto no-scrollbar pb-24" style={{ background: t.pageBg }}>
            {/* ── 天空舞台：剧情时间 + 观测 ── */}
            <div className="relative mx-4 mt-3 rounded-3xl overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,.18)]" style={{ background: t.skyBg }}>
                {isNight ? (
                    <>
                        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: starsBg, animation: 'wh-twinkle 3.4s ease-in-out infinite' }} />
                        <div className="absolute top-4 right-6 w-10 h-10 rounded-full pointer-events-none"
                            style={{ background: '#f8f3d9', boxShadow: '0 0 24px 6px rgba(248,243,217,.45)', clipPath: 'circle(50%)' }}>
                            <div className="absolute -left-2 -top-1 w-9 h-9 rounded-full" style={{ background: '#23284f' }} />
                        </div>
                    </>
                ) : (
                    <>
                        <div className="absolute top-4 right-6 w-11 h-11 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle,#fff6d8 30%,#ffd76e 70%)', boxShadow: '0 0 30px 10px rgba(255,215,110,.45)' }} />
                        <div className="absolute top-7 left-6 w-16 h-5 rounded-full bg-white/70 blur-[2px] pointer-events-none" style={{ animation: 'wh-drift 7s ease-in-out infinite' }} />
                        <div className="absolute top-12 left-24 w-10 h-3.5 rounded-full bg-white/50 blur-[2px] pointer-events-none" style={{ animation: 'wh-drift 9s ease-in-out infinite reverse' }} />
                    </>
                )}
                <div className="relative px-4 pt-4 pb-4">
                    <div className="flex items-center gap-1.5">
                        <span className={`text-[8.5px] font-black px-2 py-0.5 rounded-full tracking-wider ${MODE_INFO[world.mode].badge}`}>{MODE_INFO[world.mode].short}</span>
                        {(world.offlineTickSlots?.length || 0) > 0 && (
                            <span className="text-[8.5px] font-bold px-2 py-0.5 rounded-full bg-black/25 text-white/85 tracking-wider">离线运转中</span>
                        )}
                    </div>
                    <div className="mt-2 flex items-end justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-1.5 text-white/85">
                                {isNight ? <MoonStars size={15} weight="fill" /> : <SunHorizon size={15} weight="fill" />}
                                <span className="text-[10px] font-bold tracking-[0.2em]">{latest ? '当前时刻' : '世界尚未开始'}</span>
                            </div>
                            <div className="text-[22px] font-black text-white leading-tight font-serif" style={{ textShadow: '0 2px 10px rgba(0,0,0,.3)' }}>
                                {storyTimeLabel(world.storyClock)}
                            </div>
                        </div>
                        <button onClick={observe} disabled={!!progress}
                            className="relative overflow-hidden wh-sheen shrink-0 px-4 py-2.5 rounded-2xl text-[12.5px] font-black tracking-wide text-amber-950 shadow-[0_6px_18px_rgba(255,180,60,.45)] disabled:opacity-60 active:scale-95 transition-transform"
                            style={{ background: 'linear-gradient(135deg,#ffd76e 0%,#ffb347 100%)' }}>
                            <span className="relative z-10 flex items-center gap-1.5"><Sparkle size={15} weight="fill" />{progress ? '演绎中…' : '观测 · 推进半天'}</span>
                        </button>
                    </div>
                    {progress && (
                        <div className="mt-3 rounded-xl bg-black/25 backdrop-blur px-3 py-2">
                            <div className="flex justify-between text-[10px] text-white/90 mb-1.5 font-semibold">
                                <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />{progress.charName ? `正在演绎：${progress.charName}` : '世界引擎运转中（NPC）…'}</span>
                                <span>{progress.done}/{progress.total}</span>
                            </div>
                            <div className="h-1.5 rounded-full bg-white/15 overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`, background: 'linear-gradient(90deg,#ffd76e,#ffb347)' }} />
                            </div>
                            <div className="text-[9px] text-white/55 mt-1">可以离开这个界面，演绎在后台继续</div>
                        </div>
                    )}
                </div>
            </div>

            <div className="px-4 mt-4 space-y-4">
                {/* ── 村庄：各家小屋（拜访） ── */}
                <div>
                    <div className={`text-[10px] font-black tracking-[0.25em] uppercase px-1 mb-2 flex items-center gap-1.5 ${t.textLabel}`}><House size={11} weight="fill" />村庄 · 去串门</div>
                    <div className="space-y-2.5">
                        {visitHouses.map(({ house, residents }) => {
                            const open = openHouseId === house.id;
                            return (
                                <div key={house.id} className={`rounded-2xl border overflow-hidden ${t.panel}`}>
                                    <button className="w-full text-left" onClick={() => setOpenHouseId(open ? null : house.id)}>
                                        {/* 屋顶 */}
                                        <div className="h-2.5" style={{ background: t.roofBg }} />
                                        <div className="flex items-center gap-3 px-3 py-2.5">
                                            {/* 草坪上的小人 */}
                                            <div className="rounded-xl px-2 pt-1.5 flex items-end -space-x-3 shrink-0" style={{ background: t.lawnBg }}>
                                                {residents.map(r => <ChibiFigure key={r.id} char={r} size={46} bob={open} />)}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-[13.5px] font-black font-serif ${t.textMain}`}>{house.name}</div>
                                                <div className={`text-[10px] truncate mt-0.5 ${t.textSub}`}>
                                                    {residents.map(r => {
                                                        const b = beatOf(r.id);
                                                        return b ? `${r.name} · ${b.location}` : `${r.name} · 还没动静`;
                                                    }).join('　')}
                                                </div>
                                            </div>
                                            {open ? <CaretDown size={14} className={t.textSub} /> : <CaretRight size={14} className={t.textSub} />}
                                        </div>
                                    </button>
                                    {open && (
                                        <div className={`px-3 pb-3 space-y-2.5 border-t ${t.divider}`}>
                                            {residents.map(r => {
                                                const b = beatOf(r.id);
                                                if (!b) return <div key={r.id} className={`text-[11px] px-1 pt-2.5 ${t.textSub}`}>{r.name} 这半天还没有故事，先观测一轮。</div>;
                                                return (
                                                    <div key={r.id} className={`mt-2.5 rounded-xl border p-3 ${t.panelSolid}`}>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`flex items-center gap-1 text-[11px] font-black ${t.textMain}`}>
                                                                <MapPin size={11} weight="fill" className="text-amber-500" />{b.charName} 在{b.location}
                                                            </span>
                                                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-400/20 text-amber-600 border border-amber-400/30">{b.mood}</span>
                                                            {(b.phone?.posts?.length || b.phone?.dms?.length) ? (
                                                                <button onClick={() => setPhoneBeat(b)}
                                                                    className="ml-auto flex items-center gap-1 text-[9.5px] font-black px-2 py-1 rounded-lg bg-slate-900 text-white shadow active:scale-95 transition-transform">
                                                                    <DeviceMobile size={11} weight="fill" />看手机
                                                                </button>
                                                            ) : null}
                                                        </div>
                                                        <p className={`text-[12px] leading-[1.7] mt-2 whitespace-pre-wrap ${t.textMain} opacity-90`}>{b.narrative}</p>
                                                        {b.statusPanel && (
                                                            <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                                                                {Object.entries(b.statusPanel).map(([k, v]) => (
                                                                    <div key={k} className={`rounded-lg px-2 py-1.5 border ${t.chip}`}>
                                                                        <div className="flex justify-between text-[9px] font-bold opacity-80"><span>{k}</span><span>{String(v)}</span></div>
                                                                        {typeof v === 'number' && (
                                                                            <div className={`h-1 rounded-full mt-1 overflow-hidden ${t.barTrack}`}>
                                                                                <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, v))}%`, background: 'linear-gradient(90deg,#34d399,#fbbf24)' }} />
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* ── 关系（有向：同一对上下两根，直观看出不对等） ── */}
                {world.relationships.length > 0 && (
                    <div className={`rounded-2xl border p-3.5 ${t.panel}`}>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase flex items-center gap-1.5 mb-2.5 ${t.textLabel}`}><UsersThree size={11} weight="fill" />羁绊</div>
                        <div className="space-y-2.5">
                            {(() => {
                                // 同一对的两条有向边排到一起展示
                                const seen = new Set<string>();
                                const groups: { fwd: typeof world.relationships[0]; rev?: typeof world.relationships[0] }[] = [];
                                for (const r of world.relationships) {
                                    const key = [r.fromId, r.toId].sort().join('|');
                                    if (seen.has(key)) continue;
                                    seen.add(key);
                                    groups.push({ fwd: r, rev: world.relationships.find(x => x.fromId === r.toId && x.toId === r.fromId) });
                                }
                                return groups.map(({ fwd, rev }) => (
                                    <div key={`${fwd.fromId}_${fwd.toId}`} className={`rounded-xl border p-2.5 space-y-2 ${t.panelSolid}`}>
                                        {[fwd, rev].filter(Boolean).map(r => (
                                            <div key={`${r!.fromId}_${r!.toId}`}>
                                                <div className={`flex justify-between items-center text-[11px] ${t.textMain}`}>
                                                    <span className="font-bold flex items-center gap-1">
                                                        {nameOf(r!.fromId)} <CaretRight size={9} weight="bold" className="opacity-50" /> {nameOf(r!.toId)}
                                                        {r!.label && <span className="text-[8.5px] font-black px-1.5 py-px rounded-full bg-rose-400/15 text-rose-500 border border-rose-400/25">{r!.label}</span>}
                                                    </span>
                                                    <span className="font-black flex items-center gap-0.5 text-rose-400"><Heart size={10} weight="fill" />{r!.value}</span>
                                                </div>
                                                <div className={`h-1.5 rounded-full overflow-hidden mt-1 ${t.barTrack}`}>
                                                    <div className="h-full rounded-full transition-all" style={{ width: `${r!.value}%`, background: 'linear-gradient(90deg,#fb7185,#fbbf24)' }} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ));
                            })()}
                        </div>
                    </div>
                )}

                {/* ── 镇上的动静（NPC） ── */}
                {latest?.npcScene && (
                    <div className={`rounded-2xl border p-3.5 ${t.panel}`}>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase flex items-center gap-1.5 mb-2 ${t.textLabel}`}>
                            <Sparkle size={11} weight="fill" />镇上的动静 · {latest.storyTime}
                        </div>
                        <p className={`text-[12px] leading-[1.7] whitespace-pre-wrap ${t.textMain} opacity-90`}>{latest.npcScene}</p>
                        {world.npcs.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap gap-1.5">
                                {world.npcs.map(n => (
                                    <span key={n.id} className={`text-[10px] px-2 py-0.5 rounded-full border ${t.chip}`}>{n.emoji || '🙂'} {n.name}</span>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* ── 世界纪事（时间线） ── */}
                {episodes.length > 0 && (
                    <div>
                        <div className={`text-[10px] font-black tracking-[0.25em] uppercase px-1 mb-2 ${t.textLabel}`}>世界纪事</div>
                        <div className="space-y-2">
                            {episodes.map(ep => {
                                const open = openEpisodeId === ep.id;
                                return (
                                    <div key={ep.id} className={`rounded-2xl border overflow-hidden ${t.panel}`}>
                                        <button className="w-full flex items-center gap-2.5 p-3 text-left" onClick={() => setOpenEpisodeId(open ? null : ep.id)}>
                                            <div className="w-8 h-8 rounded-xl shrink-0 flex items-center justify-center font-black text-[11px] text-amber-950" style={{ background: 'linear-gradient(135deg,#ffd76e,#ffb347)' }}>
                                                {ep.round}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className={`text-[12px] font-black font-serif ${t.textMain}`}>{ep.storyTime}
                                                    <span className={`text-[9px] font-normal ml-1.5 ${t.textSub}`}>{ep.trigger === 'tick' ? '离线推进' : '观测'} · {new Date(ep.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                {!open && <div className={`text-[10px] truncate mt-0.5 ${t.textSub}`}>{ep.summary}</div>}
                                            </div>
                                            {open ? <CaretDown size={14} className={`${t.textSub} shrink-0`} /> : <CaretRight size={14} className={`${t.textSub} shrink-0`} />}
                                        </button>
                                        {open && (
                                            <div className={`px-3 pb-3 space-y-2 border-t ${t.divider}`}>
                                                {ep.npcScene && <p className={`text-[11px] leading-relaxed italic whitespace-pre-wrap pt-2 ${t.textSub}`}>{ep.npcScene}</p>}
                                                {ep.beats.map(b => (
                                                    <div key={b.charId} className={`rounded-xl border p-2.5 ${t.panelSolid}`}>
                                                        <div className="flex items-center gap-2">
                                                            <span className={`text-[11px] font-black ${t.textMain}`}>{b.charName} · {b.location} · {b.mood}</span>
                                                            {(b.phone?.posts?.length || b.phone?.dms?.length) ? (
                                                                <button onClick={() => setPhoneBeat(b)} className="ml-auto p-1 rounded-md bg-slate-900 text-white active:scale-90"><DeviceMobile size={11} weight="fill" /></button>
                                                            ) : null}
                                                        </div>
                                                        <p className={`text-[11.5px] leading-[1.65] mt-1 whitespace-pre-wrap ${t.textMain} opacity-85`}>{b.narrative}</p>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <button onClick={onEdit} className={`w-full py-2.5 rounded-2xl border text-[12px] font-bold flex items-center justify-center gap-1.5 ${t.panel} ${t.textSub}`}>
                    <GearSix size={14} weight="bold" />世界设置
                </button>
            </div>

            {/* 真手机弹窗 */}
            {phoneBeat && (
                <PhoneModal
                    beat={phoneBeat}
                    char={members.find(m => m.id === phoneBeat.charId)}
                    storyTime={latest?.storyTime || storyTimeLabel(Math.max(0, world.storyClock - 1))}
                    onClose={() => setPhoneBeat(null)}
                />
            )}
        </div>
    );
};

// ============================================================
// 主组件
// ============================================================
const WorldHomeApp: React.FC = () => {
    const { closeApp, characters, addToast } = useOS();
    const [worlds, setWorlds] = useState<WorldProfile[]>([]);
    const [view, setView] = useState<'list' | 'edit' | 'world'>('list');
    const [activeId, setActiveId] = useState<string | null>(null);
    const [draft, setDraft] = useState<WorldProfile | null>(null);

    const reload = useCallback(async () => { setWorlds(await DB.getWorlds()); }, []);
    useEffect(() => { reload(); }, [reload]);

    const active = worlds.find(w => w.id === activeId) || null;

    const startCreate = () => {
        setDraft({
            id: genId('world'), name: '', worldview: '', mode: 'light',
            memberIds: [], npcs: [], houses: [], relationships: [],
            offlineTickSlots: [], storyClock: 0, injectToChat: true,
            createdAt: Date.now(), updatedAt: Date.now(),
        });
        setView('edit');
    };

    const saveWorld = async (w: WorldProfile) => {
        await DB.saveWorld(w);
        // 调度表对账：所有世界的离线 tick 设置一起重建
        const all = await DB.getWorlds();
        WorldScheduler.reconcile(all.filter(x => (x.offlineTickSlots?.length || 0) > 0).map(x => ({ worldId: x.id, slots: x.offlineTickSlots! })));
        setWorlds(all);
        setActiveId(w.id);
        setDraft(null);
        setView('world');
        addToast('世界已保存', 'success');
    };

    const deleteWorld = async (id: string) => {
        await DB.deleteWorld(id);
        const all = await DB.getWorlds();
        WorldScheduler.reconcile(all.filter(x => (x.offlineTickSlots?.length || 0) > 0).map(x => ({ worldId: x.id, slots: x.offlineTickSlots! })));
        setWorlds(all);
        setDraft(null);
        setActiveId(null);
        setView('list');
        addToast('世界已删除', 'success');
    };

    const headerTitle = view === 'edit' ? (draft && worlds.some(w => w.id === draft.id) ? '世界设置' : '创建世界')
        : view === 'world' ? (active?.name || '家园')
        : '家园';

    const goBack = () => {
        if (view === 'edit') { setDraft(null); setView(activeId && worlds.some(w => w.id === activeId) ? 'world' : 'list'); }
        else if (view === 'world') { setActiveId(null); setView('list'); }
        else closeApp();
    };

    // 世界视图的顶栏要压在深色页底上，配色跟着走
    const worldNight = view === 'world' && active ? active.storyClock % 2 === 1 : false;
    const darkHeader = view === 'world' && worldNight;
    const headerBg = view === 'world'
        ? (worldNight ? '#11142a' : '#cfe7da')
        : '#f3eee3';

    return (
        <div className="h-full w-full flex flex-col" style={{ background: view === 'edit' || view === 'list' ? '#f3eee3' : undefined }}>
            <GameStyles />
            {/* 顶栏 */}
            <div className="h-20 flex items-end pb-3 px-4 shrink-0 sticky top-0 z-10" style={{ background: headerBg }}>
                <div className="flex items-center gap-2 w-full">
                    <button onClick={goBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                        <ArrowLeft size={22} weight="bold" className={darkHeader ? 'text-indigo-100' : 'text-stone-800'} />
                    </button>
                    <h1 className={`text-xl font-black tracking-wide font-serif flex items-center gap-2 truncate ${darkHeader ? 'text-indigo-50' : 'text-stone-900'}`}>
                        {headerTitle}
                    </h1>
                    {view === 'list' && (
                        <button onClick={startCreate} className="ml-auto p-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <Plus size={20} weight="bold" className="text-stone-800" />
                        </button>
                    )}
                </div>
            </div>

            {view === 'list' && (
                <div className="flex-1 overflow-y-auto no-scrollbar px-4 pb-24 pt-1 space-y-3">
                    {/* 游戏封面横幅 */}
                    <div className="relative rounded-3xl overflow-hidden p-5 shadow-[0_10px_30px_rgba(20,30,60,.3)]" style={{ background: 'linear-gradient(150deg,#16203e 0%,#23315c 55%,#2c4a4f 100%)' }}>
                        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: starsBg, animation: 'wh-twinkle 4s ease-in-out infinite' }} />
                        <div className="relative">
                            <div className="text-[9px] font-black tracking-[0.45em] text-amber-300/80 uppercase">World · Home</div>
                            <div className="text-[26px] font-black text-white font-serif tracking-[0.18em] mt-1" style={{ textShadow: '0 2px 14px rgba(255,200,100,.25)' }}>家　园</div>
                            <p className="text-[10.5px] leading-[1.7] text-indigo-100/70 mt-2">
                                把同一世界观的角色放进一个世界，让他们在你不看的时候慢慢生活。
                                每次<b className="text-amber-200">观测</b>，世界推进半天——每个角色独立演绎，绝不上帝视角；
                                NPC 由世界引擎一口气演完。所有故事都会写回各自的聊天与记忆。
                            </p>
                        </div>
                    </div>

                    {worlds.map(w => {
                        const ms = w.memberIds.map(id => characters.find(c => c.id === id)).filter(Boolean) as CharacterProfile[];
                        const night = w.storyClock % 2 === 1;
                        return (
                            <button key={w.id} onClick={() => { setActiveId(w.id); setView('world'); }}
                                className="w-full rounded-2xl overflow-hidden text-left shadow-[0_4px_16px_rgba(60,50,30,.12)] active:scale-[0.99] transition-transform border border-white/60">
                                {/* 世界缩略天空 */}
                                <div className="relative h-14 flex items-end px-3.5 pb-1.5" style={{ background: night ? 'linear-gradient(180deg,#1a1f3c,#33395f)' : 'linear-gradient(180deg,#7cbbe4,#cfe9d6)' }}>
                                    {night && <div className="absolute inset-0" style={{ backgroundImage: starsBg }} />}
                                    <div className="relative flex -space-x-3 items-end">
                                        {ms.slice(0, 5).map(m => <ChibiFigure key={m.id} char={m} size={42} />)}
                                    </div>
                                    <span className={`absolute top-2 right-3 text-[8.5px] font-black px-2 py-0.5 rounded-full ${MODE_INFO[w.mode].badge}`}>{MODE_INFO[w.mode].short}</span>
                                </div>
                                <div className="bg-white/90 px-3.5 py-2.5 flex items-center">
                                    <div className="min-w-0">
                                        <div className="text-[14px] font-black font-serif text-stone-800 truncate">{w.name}</div>
                                        <div className="text-[10px] text-stone-500 mt-0.5">
                                            {ms.length} 位角色{w.npcs.length > 0 ? ` · ${w.npcs.length} 个NPC` : ''} · {storyTimeLabel(w.storyClock)}
                                        </div>
                                    </div>
                                    <CaretRight size={14} className="text-stone-400 shrink-0 ml-auto" />
                                </div>
                            </button>
                        );
                    })}
                    {worlds.length === 0 && (
                        <button onClick={startCreate} className="w-full rounded-2xl border-2 border-dashed border-stone-300 py-10 text-stone-500 text-[13px] font-bold flex flex-col items-center gap-2 bg-white/40">
                            <Plus size={24} weight="bold" />创建第一个世界
                        </button>
                    )}
                </div>
            )}

            {view === 'edit' && draft && (
                <WorldEditor
                    draft={draft}
                    characters={characters}
                    onSave={saveWorld}
                    onCancel={goBack}
                    onDelete={worlds.some(w => w.id === draft.id) ? () => deleteWorld(draft.id) : undefined}
                />
            )}

            {view === 'world' && active && (
                <WorldView
                    world={active}
                    characters={characters}
                    onEdit={() => { setDraft(active); setView('edit'); }}
                    onWorldUpdated={reload}
                />
            )}
        </div>
    );
};

export default WorldHomeApp;
