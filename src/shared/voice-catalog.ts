/**
 * 音色清单只服务于「帮用户别填错」，不做硬校验。
 *
 * DashScope 的原话是：所选音色必须属于当前模型支持的音色列表，不能跨模型混用；
 * 混用时服务返回 InvalidParameter，具体报错形如
 * `[cosyvoice]Engine error [411]: TTS speak operation failed`。
 * 这个错误读起来完全看不出是音色的问题，所以我们既在请求失败时翻译它，
 * 也在编辑模型时把这一族模型的音色列出来当候选（仍然允许手填）。
 *
 * 清单来自官方「Qwen-Audio-TTS 音色列表」，会随厂商更新；
 * 因此未知模型一律放行，避免把用户挡在门外。
 */

export interface VoiceOption {
  id: string;
  label: string;
  group: string;
}

/** qwen-audio-3.1-tts-flash / -plus 的系统音色（省略号部分是官方列表里的长尾） */
const QWEN_AUDIO_31_VOICES: VoiceOption[] = [
  { id: "longanhuan_v3.1", label: "龙安欢 · 女 · 多语种/方言", group: "多语种与方言" },
  { id: "longanlingxin_v3.1", label: "龙安灵心 · 女 · 多语种/方言", group: "多语种与方言" },
  { id: "longanfengyue_v3.1", label: "龙安风悦 · 女 · 多语种/方言", group: "多语种与方言" },
  { id: "xunanchuan_v3.1", label: "许南川 · 男 · 多语种/方言", group: "多语种与方言" },
  { id: "yuxiaoyun_v3.1", label: "于小云 · 女 · 元气亲切", group: "中文" },
  { id: "qiaoxiaojiao_v3.1", label: "乔小娇 · 女 · 俏丽可爱", group: "中文" },
  { id: "xiaxiaochen_v3.1", label: "夏小晨 · 女 · 元气明亮", group: "中文" },
  { id: "anmingyuan_v3.1", label: "安明远 · 男 · 清亮自然", group: "中文" },
  { id: "wenhuaiqing_v3.1", label: "温怀清 · 女 · 柔和", group: "中文" },
  { id: "anxiaolan_v3.1", label: "安小岚 · 女 · 清甜", group: "中文" },
  { id: "xieshurou_v3.1", label: "谢舒柔 · 女 · 知性", group: "中文" },
  { id: "baiqinglan_v3.1", label: "白清岚 · 女 · 明亮", group: "中文" },
  { id: "xuyuyuan_v3.1", label: "许玉远 · 女 · 成熟", group: "中文" },
  { id: "anruorou_v3.1", label: "安若柔 · 女 · 气声", group: "中文" },
  { id: "wenhuaizhi_v3.1", label: "闻怀之 · 女 · 稳重", group: "中文" },
  { id: "xiaoxingzhi_v3.1", label: "萧行之 · 女 · 端庄", group: "中文" },
  { id: "guyunshu_v3.1", label: "顾云舒 · 女 · 成熟", group: "中文" },
  { id: "huozhuoshi_v3.1", label: "霍拙石 · 男 · 清亮", group: "中文" },
  { id: "yeqinghe_v3.1", label: "叶清禾 · 女 · 亲切", group: "中文" },
  { id: "yunhuanhuan_v3.1", label: "云欢欢 · 女 · 高亢", group: "中文" },
  { id: "xuxiaoqiao_v3.1", label: "徐小俏 · 女 · 俏皮", group: "中文" },
  { id: "baianran_v3.1", label: "白安然 · 女 · 低沉", group: "中文" },
  { id: "xuyanchu_v3.1", label: "许言初 · 女 · 沉稳磁性", group: "中文" },
  { id: "yezhiqing_v3.1", label: "叶知晴 · 女 · 轻快", group: "中文" },
  { id: "andi_v3.1", label: "安迪 · 男 · ABC 口音", group: "中文" },
  { id: "anyuqing_v3.1", label: "安语晴 · 女 · 甜妹", group: "中文" },
  { id: "Emily_v3.1", label: "Emily · 女 · 英式", group: "英文" },
  { id: "Luna_v3.1", label: "Luna · 女 · 英式", group: "英文" },
  { id: "Eric_v3.1", label: "Eric · 男 · 英式", group: "英文" },
  { id: "Luca_v3.1", label: "Luca · 男 · 英式", group: "英文" },
  { id: "Abby_v3.1", label: "Abby · 女 · 美式", group: "英文" },
  { id: "Annie_v3.1", label: "Annie · 女 · 美式", group: "英文" },
  { id: "Ava_v3.1", label: "Ava · 女 · 美式", group: "英文" },
  { id: "Beth_v3.1", label: "Beth · 女 · 美式", group: "英文" },
  { id: "Betty_v3.1", label: "Betty · 女 · 美式", group: "英文" },
  { id: "Cally_v3.1", label: "Cally · 女 · 美式", group: "英文" },
  { id: "Cindy_v3.1", label: "Cindy · 女 · 美式", group: "英文" },
  { id: "Donna_v3.1", label: "Donna · 女 · 美式", group: "英文" },
  { id: "Andy_v3.1", label: "Andy · 男 · 美式", group: "英文" },
  { id: "Brian_v3.1", label: "Brian · 男 · 美式", group: "英文" },
  { id: "David_v3.1", label: "David · 男 · 美式", group: "英文" },
  { id: "longanyuanfei_v3.1", label: "龙安元妃 · 女 · 高傲", group: "其他" },
  { id: "longjielidou_v3.1", label: "龙杰力豆 · 男 · 男童", group: "其他" },
  { id: "longanlingxi_v3.1", label: "龙安灵希 · 女 · 甜美", group: "其他" },
  { id: "longhuohuo_v3.1", label: "龙火火 · 男 · 顽皮少年", group: "其他" },
  { id: "longyingtao_v3.1", label: "龙应桃 · 女 · 温柔", group: "其他" },
  { id: "longanya_v3.1", label: "龙安雅 · 女 · 高雅", group: "其他" },
  { id: "longwan_v3.1", label: "龙婉 · 女 · 细腻柔声", group: "其他" },
  { id: "longxing_v3.1", label: "龙星 · 女 · 温婉邻家", group: "其他" },
];

interface VoiceFamily {
  /** 模型 ID 的匹配规则 */
  match: RegExp;
  /** 官方标记的默认音色 */
  fallback: string;
  voices: VoiceOption[];
}

const FAMILIES: VoiceFamily[] = [
  { match: /^qwen-audio-3\.1-tts-(flash|plus)$/i, fallback: "longanhuan_v3.1", voices: QWEN_AUDIO_31_VOICES },
];

function familyOf(modelId: string): VoiceFamily | null {
  const id = modelId.trim();
  return FAMILIES.find((family) => family.match.test(id)) ?? null;
}

/** 这个模型的候选音色；不认识的模型返回 null（表示「我们不知道，别拦」）。 */
export function voicesForModel(modelId: string): VoiceOption[] | null {
  return familyOf(modelId)?.voices ?? null;
}

/** 这个模型的默认音色；不认识的模型返回 null。 */
export function defaultVoiceFor(modelId: string): string | null {
  return familyOf(modelId)?.fallback ?? null;
}

/**
 * 音色是否属于这个模型。
 * 不认识的模型返回 null —— 调用方据此「不判断」，而不是报错。
 */
export function isKnownVoice(modelId: string, voice: string): boolean | null {
  const family = familyOf(modelId);
  if (!family) return null;
  return family.voices.some((option) => option.id === voice.trim());
}

/** 给 UI 的一句话说明；未知模型返回 null。 */
export function voiceHintFor(modelId: string): string | null {
  const family = familyOf(modelId);
  if (!family) return null;
  return `音色必须属于这个模型，跨模型混用会被服务拒绝（InvalidParameter）。共 ${family.voices.length} 个候选，也可以手填。`;
}
