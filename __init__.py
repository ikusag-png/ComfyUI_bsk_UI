"""
ComfyUI bsk UI
=======================

一个为 ComfyUI 提供干净、可定制 GUI 操作面板的扩展。
"""

import random
import json
from pathlib import Path
import os, gc
import torch

from comfy import model_management as mm

import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "comfy"))

import comfy.utils

from comfy.utils import common_upscale
try:
    from server import PromptServer
except:
    PromptServer = None
import folder_paths

import comfy
import json

import torchvision.transforms as T
to_pil_image = T.ToPILImage()
# ComfyUI_StringCacheNode.py
# -*- coding: utf-8 -*-
import re


script_directory = os.path.dirname(os.path.abspath(__file__))

device = mm.get_torch_device()
offload_device = mm.unet_offload_device()

VAE_STRIDE = (4, 8, 8)
PATCH_SIZE = (1, 2, 2)
MAX_RESOLUTION=16384


EXTENSION_DIR = Path(__file__).parent
WEB_DIRECTORY = "js"
VERSION = "1.3.0"  # 版本升级

print(f"[ComfyUI bsk UI] Extension loading (v{VERSION})...")

# 文本编辑器节点

class bsk_StringMergeWithSwitch:
    """
    一个支持三个字符串输入和开关控制的合并节点。
    """
    
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                # 输入字符串，默认为空，forceInput设为False允许不连接
                "input1": ("STRING", {"default": "", "forceInput": False}),
                # 开关选项，默认为True（开启）
                "switch1": ("BOOLEAN", {"default": True}),
                
                "input2": ("STRING", {"default": "", "forceInput": False}),
                "switch2": ("BOOLEAN", {"default": True}),
                
                "input3": ("STRING", {"default": "", "forceInput": False}),
                "switch3": ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("merged_string",)
    FUNCTION = "merge_strings"
    CATEGORY = "utils/text" # 节点在菜单中的分类

    def merge_strings(self, input1="", switch1=True, input2="", switch2=True, input3="", switch3=True):
        parts = []
        
        # 将输入和开关打包处理
        inputs = [
            (input1, switch1),
            (input2, switch2),
            (input3, switch3)
        ]
        
        for text, is_on in inputs:
            # 检查开关是否开启，且文本是否有效（非空且非None）
            # 注意：未连接的输入在ComfyUI中通常会传入默认值（这里是空字符串）
            if is_on and text:
                # 去除首尾空白
                clean_text = text.strip()
                if clean_text:
                    # 检查末尾是否有逗号或空格，如果有则去除，为了统一格式
                    # 这样无论用户输入 "aa" 还是 "aa," 还是 "aa, "，都能整齐合并
                    clean_text = clean_text.rstrip(", ")
                    
                    # 添加到列表
                    parts.append(clean_text)
        
        # 将所有部分用 ", " 连接
        # 比如 "aa" 和 "bb" -> "aa, bb"
        result = ", ".join(parts)
        
        return (result,)

class MultiLineStringEditor:
    """
    ComfyUI节点：多行字符串编辑器
    功能：
    1. 支持多行字符串输入
    2. 支持Ctrl+/快捷键注释/取消注释当前行
    3. 自动过滤被注释行和空行
    4. 支持行内注释过滤（逗号分隔的提示词）
    5. 输出连续字符串（保留空格）
    
    注释过滤策略：
    - 整行注释：行开头有#（忽略前导空格），过滤整行
    - 行内注释：行开头没有#，但行中间有#，只过滤带#的提示词
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {
                    "multiline": True, 
                    "default": "",
                    "placeholder": "输入多行文本，使用Ctrl+/注释/取消注释当前行\n支持行内注释：aa, bb, # cc, dd → aa, bb, dd",
                    "dynamicPrompts": False
                }),
                "separator": ("STRING", {
                    "default": " ",
                    "placeholder": "分隔符（默认为空格）"
                })
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process_text"
    CATEGORY = "文本处理"

    def process_text(self, text, separator=" "):
        """
        处理文本：移除注释行和空行，输出连续字符串
        
        过滤策略：
        1. 整行注释：如果行开头有#（忽略前导空格），跳过整行
        2. 行内注释：如果行开头没有#，但行内有#，过滤带#的提示词
        3. 空行：跳过完全空白的行
        """
        lines = text.split('\n')
        processed_lines = []
        
        for line in lines:
            stripped = line.lstrip()
            
            # 策略1：整行注释 - 行开头有#，跳过整行
            if stripped.startswith('#'):
                continue
            
            # 策略3：跳过完全空白行
            if not stripped:
                continue
            
            # 策略2：行内注释 - 行内有#，过滤带#的提示词
            if '#' in line:
                processed_line = self._filter_inline_comments(line)
                if processed_line.strip():  # 确保过滤后不为空
                    processed_lines.append(processed_line)
            else:
                # 无注释，直接添加
                processed_lines.append(line)
        
        # 使用指定分隔符合并所有行
        result = separator.join(processed_lines)
        
        return (result,)
    
    def _filter_inline_comments(self, line):
        """
        过滤行内带#的提示词（逗号分隔）
        保留原始的逗号结构
        
        例如：
        "aa, bb, cc, # dd, ff, gg, #hhh" → "aa, bb, cc, ff, gg,"
        "cat, dog, #bird, fish" → "cat, dog, fish"
        """
        # 解析：按逗号分割，同时记录每个部分后面是否有逗号
        parts = []
        current = ""
        for char in line:
            if char == ',':
                parts.append((current, True))  # (内容, 后面有逗号)
                current = ""
            else:
                current += char
        parts.append((current, False))  # 最后一部分没有逗号
        
        # 过滤带#的提示词，但保留逗号信息
        filtered_parts = []
        for content, has_comma in parts:
            stripped = content.lstrip()
            # 检查是否是被注释的提示词（以#开头）
            if stripped.startswith('#'):
                # 被注释的提示词，跳过内容，但保留逗号给前一个元素
                if filtered_parts and has_comma:
                    # 将逗号转移给前一个元素
                    filtered_parts[-1] = (filtered_parts[-1][0], True)
                continue
            else:
                filtered_parts.append((content, has_comma))
        
        # 重新连接
        result = ""
        for content, has_comma in filtered_parts:
            result += content
            if has_comma:
                result += ","
        
        return result


"""
ComfyUI 字符串处理节点 - Prompt String Processor
用于对输入的提示词字符串进行条件去除和替换操作

规则格式：
- if: abc: 去除包含单词的     # 去除包含单词abc的提示词
- if: abc: 去除单词相同的     # 去除完全等于abc的提示词
- if: abc: 替换包含单词的:aabbcc   # 替换包含单词abc的提示词为aabbcc
- if: abc: 替换完全相同的:aabbcc   # 替换完全等于abc的提示词为aabbcc

注意：匹配必须是完整单词，不会匹配单词的一部分
例如：abc 不会匹配 abcccc 或 xabc
"""

class PromptStringProcessor:
    """
    提示词字符串处理节点
    支持条件去除和替换操作
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "输入的提示词字符串，用逗号分隔"
                }),
                "rules": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "tooltip": "处理规则，每行一条规则"
                }),
            },
        }
    
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("processed_prompt",)
    FUNCTION = "process"
    CATEGORY = "string"
    DESCRIPTION = "对提示词字符串进行条件去除和替换操作"
    
    def process(self, prompt: str, rules: str) -> tuple:
        """
        处理提示词字符串
        
        Args:
            prompt: 输入的提示词字符串
            rules: 处理规则（多行字符串）
            
        Returns:
            处理后的字符串元组
        """
        # 如果没有规则，直接返回原字符串
        if not rules.strip():
            return (prompt,)
        
        # 解析提示词（按逗号分割，去除空白）
        prompt_parts = [p.strip() for p in prompt.split(',') if p.strip()]
        
        # 解析并应用每条规则
        for rule_line in rules.strip().split('\n'):
            rule_line = rule_line.strip()
            if not rule_line:
                continue
            
            prompt_parts = self._apply_rule(prompt_parts, rule_line)
        
        # 重新组合成字符串
        result = ', '.join(prompt_parts)
        return (result,)
    
    def _apply_rule(self, prompt_parts: list, rule_line: str) -> list:
        """
        应用单条规则
        
        Args:
            prompt_parts: 提示词列表
            rule_line: 规则行
            
        Returns:
            处理后的提示词列表
        """
        # 解析规则
        parsed = self._parse_rule(rule_line)
        if parsed is None:
            return prompt_parts
        
        action, keyword, replacement = parsed
        
        if action == "remove_contains":
            # 去除包含该单词的提示词
            return [p for p in prompt_parts if not self._contains_word(p, keyword)]
        
        elif action == "remove_exact":
            # 去除完全相同的提示词
            return [p for p in prompt_parts if p != keyword]
        
        elif action == "replace_contains":
            # 替换包含该单词的提示词
            return [replacement if self._contains_word(p, keyword) else p for p in prompt_parts]
        
        elif action == "replace_exact":
            # 替换完全相同的提示词
            return [replacement if p == keyword else p for p in prompt_parts]
        
        return prompt_parts
    
    def _parse_rule(self, rule_line: str):
        """
        解析规则行
        
        Args:
            rule_line: 规则行字符串
            
        Returns:
            (action, keyword, replacement) 或 None
            action: remove_contains, remove_exact, replace_contains, replace_exact
            keyword: 关键词
            replacement: 替换内容（去除操作时为None）
        """
        # 规则格式：
        # if: abc: 去除包含单词的
        # if: abc: 去除单词相同的
        # if:abc: 替换包含单词的:aabbcc
        # if:abc: 替换完全相同的:aabbcc
        
        # 匹配 if: 后面的内容
        # 支持两种格式：if: abc: 和 if:abc:
        pattern = r'^if:\s*(.+?):\s*(.+)$'
        match = re.match(pattern, rule_line)
        
        if not match:
            return None
        
        keyword = match.group(1).strip()
        rest = match.group(2).strip()
        
        # 判断操作类型
        if rest.startswith("去除包含单词的"):
            return ("remove_contains", keyword, None)
        
        elif rest.startswith("去除单词相同的"):
            return ("remove_exact", keyword, None)
        
        elif rest.startswith("替换包含单词的:"):
            replacement = rest[len("替换包含单词的:"):].strip()
            return ("replace_contains", keyword, replacement)
        
        elif rest.startswith("替换完全相同的:"):
            replacement = rest[len("替换完全相同的:"):].strip()
            return ("replace_exact", keyword, replacement)
        
        return None
    
    def _contains_word(self, text: str, word: str) -> bool:
        """
        检查文本中是否包含指定单词（完整单词匹配）
        
        Args:
            text: 要检查的文本
            word: 要查找的单词
            
        Returns:
            是否包含该单词
        """
        # 使用正则表达式进行完整单词匹配
        # \b 表示单词边界
        pattern = r'\b' + re.escape(word) + r'\b'
        return bool(re.search(pattern, text, re.IGNORECASE))



# ---------------------------
# 工具函数：规范化添加逗号
# ---------------------------
def append_with_comma(original, addition):
    """将addition以逗号分隔的格式追加到original末尾"""
    if not original:
        return addition
    if original.endswith(', ') or original.endswith(','):
        return original + addition
    else:
        return original + ', ' + addition
class LoraLoaderWithPath:
    def __init__(self):
        self.loaded_lora = None

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The diffusion model the LoRA will be applied to."}),
                "clip": ("CLIP", {"tooltip": "The CLIP model the LoRA will be applied to."}),
                "lora_name": (folder_paths.get_filename_list("loras"), {"tooltip": "The name of the LoRA."}),
                "strength_model": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01, "tooltip": "How strongly to modify the diffusion model. This value can be negative."}),
                "strength_clip": ("FLOAT", {"default": 1.0, "min": -100.0, "max": 100.0, "step": 0.01, "tooltip": "How strongly to modify the CLIP model. This value can be negative."}),
            },
            "optional": {
                "lora_path": ("STRING", {"default": "", "tooltip": "Absolute path to LoRA file. If provided and file exists, this takes priority over lora_name."}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    OUTPUT_TOOLTIPS = ("The modified diffusion model.", "The modified CLIP model.")
    FUNCTION = "load_lora"

    CATEGORY = "loaders"
    DESCRIPTION = "LoRAs are used to modify diffusion and CLIP models, altering the way in which latents are denoised such as applying styles. Multiple LoRA nodes can be linked together."
    SEARCH_ALIASES = ["lora", "load lora", "apply lora", "lora loader", "lora model"]

    def load_lora(self, model, clip, lora_name, strength_model, strength_clip, lora_path=""):
        if strength_model == 0 and strength_clip == 0:
            return (model, clip)

        # 确定要使用的LoRA路径
        import os
        use_path = None
        
        # 如果提供了lora_path且文件存在，优先使用
        if lora_path and lora_path.strip():
            if os.path.exists(lora_path):
                use_path = lora_path
            else:
                print(f"Warning: Provided LoRA path does not exist: {lora_path}")
                print(f"Falling back to lora_name: {lora_name}")
        
        # 如果lora_path无效，使用lora_name
        if use_path is None:
            use_path = folder_paths.get_full_path_or_raise("loras", lora_name)

        # 检查缓存的LoRA
        lora = None
        if self.loaded_lora is not None:
            if self.loaded_lora[0] == use_path:
                lora = self.loaded_lora[1]
            else:
                self.loaded_lora = None

        # 加载LoRA
        if lora is None:
            lora = comfy.utils.load_torch_file(use_path, safe_load=True)
            self.loaded_lora = (use_path, lora)

        model_lora, clip_lora = comfy.sd.load_lora_for_models(model, clip, lora, strength_model, strength_clip)
        return (model_lora, clip_lora)

# ---------------------------
# 核心节点类
# ---------------------------

class StringRuleProcessor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "input_string": ("STRING", {
                    "multiline": False,      
                    "default": ""
                }),
                "rules": ("STRING", {
                    "multiline": True,       
                    "default": "# 示例规则：\nif perlica_(Arknights): 1girl, long_hair\nif abc: abc ccc else: default_abc"
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "utils/text"

    def append_with_comma(self, text, add_text):
        """辅助函数：智能追加文本"""
        if not add_text:
            return text
        text = text.strip()
        add_text = add_text.strip()
        if not text:
            return add_text
        if text.endswith(','):
            return f"{text} {add_text}"
        else:
            return f"{text}, {add_text}"

    def process(self, input_string, rules):
        output = input_string
        
        # 核心改进1：为了准确判断“是否存在”，我们将output按逗号分割成标签集合
        # 这样可以完美规避括号等特殊字符在正则搜索中的歧义，也能处理前后空格
        current_tags = set(tag.strip().lower() for tag in output.split(',') if tag.strip())

        lines = rules.split('\n')

        for line in lines:
            line = line.strip()
            if not line or line.startswith('#'):
                continue

            # 核心改进2：更健壮的正则解析
            # 解释：
            # ^\s*if\s+          -> 匹配开始 if
            # (.+?)              -> group1: 关键词 (非贪婪，匹配到第一个冒号前)
            # \s*:\s*            -> 匹配冒号分隔符
            # (.+?)              -> group2: 存在时添加的内容 (非贪婪，匹配到 else 或 行尾)
            # (?:\s+else:\s*(.+))?$ -> 可选的 else 分支，group3: 不存在时添加的内容
            match = re.match(
                r'^\s*if\s+(.+?)\s*:\s*(.+?)(?:\s+else:\s*(.+))?\s*$',
                line,
                re.IGNORECASE
            )
            
            if not match:
                continue

            # 提取并清理关键词
            word = match.group(1).strip()
            # 检查时忽略大小写，并去除首尾空格进行比较
            word_check = word.lower().strip()
            
            add_if_exists = match.group(2).strip()
            add_if_not_exists = match.group(3).strip() if match.group(3) else None

            # 核心改进3：使用集合进行存在性检查，而不是正则搜索
            # 这样即使 word 是 "perlica_(Arknights)" 这种带括号的，也能精准匹配，不会报错
            is_present = word_check in current_tags

            if is_present:
                if add_if_exists:
                    output = self.append_with_comma(output, add_if_exists)
                    # 更新集合，以便后续规则可以使用本次添加的标签
                    new_tags = [t.strip().lower() for t in add_if_exists.split(',') if t.strip()]
                    current_tags.update(new_tags)
            else:
                if add_if_not_exists:
                    output = self.append_with_comma(output, add_if_not_exists)
                    new_tags = [t.strip().lower() for t in add_if_not_exists.split(',') if t.strip()]
                    current_tags.update(new_tags)

        return (output,)


class StringProcessor:
    """
    ComfyUI字符串处理插件
    主要功能：
    1. 从提示词中去除完全相同的提示词片段
    2. 处理多行字符串输入框，按逗号分割并去除逗号后空格
    3. 忽略以 "# " 开头的注释行
    4. 格式化输出：标点后添加空格，删除换行，去除多余的标点和空格
    """
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "strings_to_remove": ("STRING", {
                    "multiline": True, 
                    "default": "",
                    "placeholder": "输入要移除的字符串，每行一个或用逗号分隔"
                }),
                "match_whole_token": ("BOOLEAN", {
                    "default": True,
                    "label": "整词匹配"
                }),
            },
            "optional": {
                "input_string": ("STRING", {
                    "multiline": True, 
                    "default": "",
                    "placeholder": "输入需要处理的字符串",
                    "forceInput": True  # 这个设为可选并强制输入
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("processed_text",)
    FUNCTION = "process_string"
    CATEGORY = "文本处理"
    
    def __init__(self):
        # 扩展分隔符集合，包括所有常见的提示词分隔符
        # 英文：, ; . ! ? 
        # 中文：，；。！？
        self.token_separators = r""",，;；.。!！?？:："""
        self.separator_pattern = f"[{re.escape(self.token_separators)}]"
        
        # 所有标点符号用于清理
        self.all_punctuation = r""",，;；.。!！?？:：'"'"（）【】《》〈〉『』「」[]{}()!@#$%^&*+=\-|\\~`<>"""
        self.all_punctuation_pattern = f"[{re.escape(self.all_punctuation)}]"

    def parse_removal_strings(self, strings_to_remove):
        """解析要去除的字符串列表"""
        removal_strings = []
        
        # 按行分割字符串输入框内容
        lines = strings_to_remove.split('\n')
        
        for line in lines:
            line = line.strip()
            # 忽略以 "# " 开头的注释行
            if line.startswith("# "):
                continue
                
            # 按逗号分割并去除逗号后空格
            parts = line.split(',')
            for part in parts:
                cleaned_part = part.strip()
                if cleaned_part:
                    removal_strings.append(cleaned_part)
        
        return removal_strings
    
    def split_prompt_tokens(self, text):
        """将提示词文本分割成独立的提示词"""
        if not text:
            return []
            
        # 统一替换所有分隔符为逗号，便于处理
        # 使用正则表达式替换所有分隔符为逗号
        normalized_text = re.sub(self.separator_pattern, ',', text)
        
        # 使用逗号分割提示词
        tokens = normalized_text.split(',')
        
        # 清理每个提示词
        cleaned_tokens = []
        for token in tokens:
            token = token.strip()
            if token:  # 只保留非空提示词
                # 移除提示词内部的多余空格
                token = re.sub(r'\s+', ' ', token)
                cleaned_tokens.append(token)
        
        return cleaned_tokens
    
    def remove_whole_tokens(self, text, removal_strings):
        """整词匹配模式：只移除完全相同的提示词"""
        if not text or not text.strip():
            return self.format_output("")
        
        if not removal_strings:
            return self.format_output(text)
        
        # 分割提示词
        tokens = self.split_prompt_tokens(text)
        
        # 转换为集合以便快速查找（移除完全匹配的提示词）
        removal_set = set(removal_strings)
        
        # 过滤掉完全匹配的提示词
        filtered_tokens = [token for token in tokens if token not in removal_set]
        
        return self.format_output(", ".join(filtered_tokens))
    
    def remove_containing_substrings(self, text, removal_strings):
        """包含子串模式：移除包含指定子串的提示词"""
        if not text or not text.strip():
            return self.format_output("")
        
        if not removal_strings:
            return self.format_output(text)
        
        # 分割提示词
        tokens = self.split_prompt_tokens(text)
        
        # 过滤掉包含任何要移除子串的提示词
        filtered_tokens = []
        for token in tokens:
            should_keep = True
            for removal_str in removal_strings:
                if removal_str and removal_str in token:
                    should_keep = False
                    break
            if should_keep:
                filtered_tokens.append(token)
        
        return self.format_output(", ".join(filtered_tokens))
    
    def format_output(self, text):
        """格式化输出：确保末尾有逗号和空格，清理格式"""
        if not text or text.strip() == "":
            return ", "
        
        # 清理文本
        result = text
        
        # 删除换行符
        result = result.replace('\n', ' ').replace('\r', ' ')
        
        # 清理连续的标点符号
        result = re.sub(f'({self.all_punctuation_pattern})\\1+', r'\1', result)
        
        # 清理多余的空格
        result = re.sub(r'\s+', ' ', result).strip()
        
        # 清理开头和结尾的逗号
        result = re.sub(r'^[,\s]+', '', result)
        result = re.sub(r'[,\s]+$', '', result)
        
        # 确保末尾有逗号和空格
        if result and not result.endswith(", "):
            result = result + ", "
        
        return result
    
    def process_string(self, input_string="", strings_to_remove="", match_whole_token=True):
        # 解析要去除的字符串
        removal_strings = self.parse_removal_strings(strings_to_remove)
        
        # 根据开关选择移除模式
        if match_whole_token:
            # 整词匹配模式（默认）：只移除完全相同的提示词
            result = self.remove_whole_tokens(input_string, removal_strings)
        else:
            # 包含子串模式：移除包含指定子串的提示词
            result = self.remove_containing_substrings(input_string, removal_strings)
        
        return (result,)



class ComfyUIPanelNode:
    """占位节点 - 实际功能通过前端 JavaScript 实现"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {},
        }

    RETURN_TYPES = ()
    FUNCTION = "execute"
    CATEGORY = "utils"
    OUTPUT_NODE = True

    def execute(self):
        return {}

class RandomSeedNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed_str": ("STRING", {"default": "0", "multiline": False})
            }
        }

    RETURN_TYPES = ("INT",)
    FUNCTION = "generate"
    CATEGORY = "utils"

    def generate(self, seed_str):
        if not isinstance(seed_str, str):
            seed_str = str(seed_str)
        cleaned = seed_str.strip()
        if cleaned == "-1":
            # 生成一个 0 到 2^64-1 之间的随机整数作为种子，匹配 ComfyUI 官方范围
            seed = random.randint(0, 2**64 - 1)
            print(f"[RandomSeedNode] 使用随机种子: {seed}")
        else:
            seed = int(cleaned)
            print(f"[RandomSeedNode] 种子: {seed}")
        return (seed,)

#region I2V encode with frame selection
#region I2V encode with correct channel handling
class bsk_WanVideoImageToVideoEncodeSelective:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "width": ("INT", {"default": 832, "min": 64, "max": 8096, "step": 8}),
            "height": ("INT", {"default": 480, "min": 64, "max": 8096, "step": 8}),
            "num_frames": ("INT", {"default": 81, "min": 1, "max": 10000, "step": 4}),
            "noise_aug_strength": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.001}),
            "start_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001}),
            "end_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001}),
            "force_offload": ("BOOLEAN", {"default": True}),
            
            # 选择性输出参数
            "output_mode": (["single_frame", "frame_range", "all_frames", "none"], {
                "default": "all_frames",
            }),
            "target_frame": ("INT", {"default": 40, "min": 0, "max": 10000}),
            "frame_range_start": ("INT", {"default": 20, "min": 0, "max": 10000}),
            "frame_range_end": ("INT", {"default": 60, "min": 0, "max": 10000}),
            "other_frames_stop_step": ("INT", {"default": 5, "min": 0, "max": 100}),
            "output_frames_as_list": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "vae": ("WANVAE",),
                "clip_embeds": ("WANVIDIMAGE_CLIPEMBEDS",),
                "start_image": ("IMAGE",),
                "end_image": ("IMAGE",),
                "keyframe1": ("IMAGE",),
                "keyframe2": ("IMAGE",),
                "keyframe3": ("IMAGE",),
                "keyframe1_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001}),
                "keyframe2_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001}),
                "keyframe3_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001}),
                "control_embeds": ("WANVIDIMAGE_EMBEDS",),
                "fun_or_fl2v_model": ("BOOLEAN", {"default": True}),
                "temporal_mask": ("MASK",),
                "extra_latents": ("LATENT",),
                "tiled_vae": ("BOOLEAN", {"default": False}),
                "add_cond_latents": ("ADD_COND_LATENTS",),
                "augment_empty_frames": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.01}),
                "empty_frame_pad_image": ("IMAGE",),
            }
        }

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS", "IMAGE", "WANVIDFRAMEMASK")
    RETURN_NAMES = ("image_embeds",  "frame_mask")
    FUNCTION = "process"
    CATEGORY = "WanVideoWrapper"

    def _calculate_keyframe_positions(self, num_frames, has_start, has_kf1, has_kf2, has_kf3, has_end):
        """
        计算所有关键帧的精确位置
        将视频帧平均分成4份，计算每个关键帧应该在的位置
        
        返回: dict，包含每个关键帧的位置索引（帧级别）
        """
        positions = {}
        
        # 计算分段大小（将视频分成4份）
        # 使用 num_frames - 1 因为帧索引从0开始
        if num_frames <= 1:
            segment_size = 0
        else:
            segment_size = (num_frames - 1) / 4.0
        
        # 计算每个关键帧的位置
        positions['start'] = 0
        positions['keyframe1'] = round(segment_size * 1)  # 25%位置
        positions['keyframe2'] = round(segment_size * 2)  # 50%位置
        positions['keyframe3'] = round(segment_size * 3)  # 75%位置
        positions['end'] = num_frames - 1  # 最后一帧
        
        # 确保位置在有效范围内
        if num_frames > 1:
            positions['keyframe1'] = min(positions['keyframe1'], num_frames - 2)
            positions['keyframe2'] = min(positions['keyframe2'], num_frames - 2)
            positions['keyframe3'] = min(positions['keyframe3'], num_frames - 2)
        
        # 确保位置顺序正确（避免重叠）
        occupied = set()
        if has_start:
            occupied.add(positions['start'])
        
        if has_kf1:
            # 找到第一个未被占用的位置
            while positions['keyframe1'] in occupied and positions['keyframe1'] < num_frames - 1:
                positions['keyframe1'] += 1
            occupied.add(positions['keyframe1'])
        
        if has_kf2:
            while positions['keyframe2'] in occupied and positions['keyframe2'] < num_frames - 1:
                positions['keyframe2'] += 1
            occupied.add(positions['keyframe2'])
        
        if has_kf3:
            while positions['keyframe3'] in occupied and positions['keyframe3'] < num_frames - 1:
                positions['keyframe3'] += 1
            occupied.add(positions['keyframe3'])
        
        return positions

    def process(self, width, height, num_frames, noise_aug_strength, 
                start_latent_strength, end_latent_strength, force_offload,
                output_mode="all_frames", target_frame=40, 
                frame_range_start=20, frame_range_end=60,
                other_frames_stop_step=5, output_frames_as_list=False,
                **kwargs):
        
        vae = kwargs.get('vae')
        if vae is None:
            raise ValueError("VAE is required for image encoding.")
        
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        H, W = height, width

        lat_h = H // vae.upsampling_factor
        lat_w = W // vae.upsampling_factor

        num_frames = ((num_frames - 1) // 4) * 4 + 1
        
        # ===== 原有的编码逻辑（保持不变）=====
        has_start = kwargs.get('start_image') is not None
        has_kf1 = kwargs.get('keyframe1') is not None
        has_kf2 = kwargs.get('keyframe2') is not None
        has_kf3 = kwargs.get('keyframe3') is not None
        has_end = kwargs.get('end_image') is not None
        
        fun_or_fl2v_model = kwargs.get('fun_or_fl2v_model', False)
        if not has_start and has_end:
            fun_or_fl2v_model = True
        
        # 计算关键帧位置
        kf_positions = self._calculate_keyframe_positions(
            num_frames, has_start, has_kf1, has_kf2, has_kf3, has_end
        )
        
        # 收集关键帧
        keyframes = []
        if has_start:
            keyframes.append(('start', kf_positions['start'], kwargs.get('start_image'), start_latent_strength))
        if has_kf1:
            keyframes.append(('keyframe1', kf_positions['keyframe1'], kwargs.get('keyframe1'), kwargs.get('keyframe1_latent_strength', 1.0)))
        if has_kf2:
            keyframes.append(('keyframe2', kf_positions['keyframe2'], kwargs.get('keyframe2'), kwargs.get('keyframe2_latent_strength', 1.0)))
        if has_kf3:
            keyframes.append(('keyframe3', kf_positions['keyframe3'], kwargs.get('keyframe3'), kwargs.get('keyframe3_latent_strength', 1.0)))
        if has_end:
            keyframes.append(('end', kf_positions['end'], kwargs.get('end_image'), end_latent_strength))
        
        keyframes.sort(key=lambda x: x[1])
        
        # 准备图像序列
        concatenated = self._prepare_image_sequence(
            keyframes, num_frames, H, W, device, vae.dtype, noise_aug_strength,
            fun_or_fl2v_model, kwargs.get('empty_frame_pad_image')
        )
        
        # ===== VAE 编码 =====
        vae.to(device)
        
        # 检查模型类型（通过 transformer 的 in_dim）
        # transformer = model.diffusion_model if hasattr(model, 'diffusion_model') else None
        is_i2v = True
        

        if is_i2v:
            # I2V 模型：需要创建带掩码的输入
            # 1. 先编码图像序列
            y = vae.encode([concatenated], device, end_=(has_end and not fun_or_fl2v_model), 
                        tiled=kwargs.get('tiled_vae', False))[0]  # [16, T, H, W]
            
            # 2. 创建掩码 (4 通道)
            mask = torch.ones(4, y.shape[1], lat_h, lat_w, device=device, dtype=y.dtype)
            
            # 3. 拼接掩码和图像 latent -> [20, T, H, W]
            image_cond = torch.cat([mask, y], dim=0)
            
            # 4. 对于 I2V 模型，image_embeds 应该是 image_cond
            final_embeds = image_cond
            
            # 5. 计算 max_seq_len (采样器需要)
            patches_per_frame = lat_h * lat_w // (PATCH_SIZE[1] * PATCH_SIZE[2])
            frames_per_stride = (num_frames - 1) // 4 + (2 if has_end and not fun_or_fl2v_model else 1)
            max_seq_len = frames_per_stride * patches_per_frame
        else:
            # T2V 模型：直接使用编码结果
            final_embeds = vae.encode([concatenated], device, end_=(has_end and not fun_or_fl2v_model), 
                                    tiled=kwargs.get('tiled_vae', False))[0]
            max_seq_len = math.ceil((lat_h * lat_w) / 4 * final_embeds.shape[1])
        
        
        # 处理 extra_latents
        extra_latents = kwargs.get('extra_latents')
        has_ref = False
        if extra_latents is not None:
            samples = extra_latents["samples"].squeeze(0)
            if is_i2v:
                # 对于 I2V，extra_latents 应该是 image_cond 的一部分
                if image_cond is not None:
                    image_cond = torch.cat([samples, image_cond], dim=1)
            else:
                final_latent = torch.cat([samples, final_latent], dim=1)
            num_frames += samples.shape[1] * 4
            has_ref = True
        
        # ===== 构建帧掩码 =====
        full_denoise_frames = set()
        if output_mode == "single_frame":
            full_denoise_frames.add(target_frame)
        elif output_mode == "frame_range":
            for f in range(frame_range_start, min(frame_range_end + 1, num_frames)):
                full_denoise_frames.add(f)
        else:  # all_frames 或 none
            for f in range(num_frames):
                full_denoise_frames.add(f)
        
        # 转换为 latent 空间索引
        full_denoise_latents = set()
        for frame_idx in full_denoise_frames:
            latent_idx = frame_idx // 4
            full_denoise_latents.add(latent_idx)
        
        # 创建帧掩码
        frame_mask = torch.zeros(num_frames, dtype=torch.bool)
        for f in full_denoise_frames:
            frame_mask[f] = True
        
        # 创建 latent 掩码
        latent_frame_mask = torch.zeros((num_frames + 3) // 4, dtype=torch.bool)
        for l in full_denoise_latents:
            latent_frame_mask[l] = True
        
        # ===== 构建 image_embeds =====
        image_embeds = {
            # 对于 I2V 模型，关键是要提供 image_cond
            # "image_cond": image_cond.cpu() if image_cond is not None else None,
            "image_embeds": final_embeds.cpu(),  # 这是关键！对于 I2V，这里是 [20, T, H, W]
            "clip_context": kwargs.get('clip_embeds', {}).get("clip_embeds") if kwargs.get('clip_embeds') else None,
            "negative_clip_context": kwargs.get('clip_embeds', {}).get("negative_clip_embeds") if kwargs.get('clip_embeds') else None,
            "num_frames": num_frames,
            "lat_h": lat_h,
            "lat_w": lat_w,
            "fun_or_fl2v_model": fun_or_fl2v_model,
            "has_ref": has_ref,
            
            # 选择性采样参数
            "frame_mask": frame_mask.cpu(),
            "latent_frame_mask": latent_frame_mask.cpu(),
            "other_frames_stop_step": other_frames_stop_step,
            "output_mode": output_mode,
            "target_frame": target_frame,
            "frame_range_start": frame_range_start,
            "frame_range_end": frame_range_end,
            "output_frames_as_list": output_frames_as_list,
            "vae": vae,
            
            # 标记模型类型
            "is_i2v": is_i2v,
        }
        
        # 生成预览帧
        # preview_frames = torch.zeros(1, 64, 64, 3)
        # if output_mode != "none" and final_latent is not None:
        #     try:
        #         preview_frames = self._generate_preview_frames(
        #             final_latent if final_latent is not None else image_cond,
        #             vae, device, output_mode, target_frame, 
        #             frame_range_start, frame_range_end,
        #             num_frames, output_frames_as_list
        #         )
        #     except Exception as e:
        #         print(f"Preview generation failed: {e}")
        
        if force_offload:
            vae.model.to(torch.device("cpu"))
        
        return (image_embeds,  frame_mask)
    
    # ... 其他辅助方法保持不变 ...
    #endregion
    def _prepare_image_sequence(self, keyframes, num_frames, H, W, device, dtype, 
                                noise_aug_strength, fun_or_fl2v_model, empty_frame_pad_image):
        """准备图像序列 - 使用正确的范围 [-1, 1]"""
        import torch
        from comfy.utils import common_upscale
        
        prepared_frames = {}
        for name, pos, img, strength in keyframes:
            if img is not None:
                img = img[..., :3]
                
                # 调整尺寸
                if img.shape[1] != H or img.shape[2] != W:
                    resized = common_upscale(img.movedim(-1, 1), W, H, "lanczos", "disabled").movedim(0, 1)
                else:
                    resized = img.permute(3, 0, 1, 2)
                
                # ComfyUI 的 IMAGE 是 [0,1] 范围，转换到 [-1,1]
                resized = resized * 2 - 1
                
                if noise_aug_strength > 0.0:
                    sigma = torch.ones((resized.shape[0],)).to(device, dtype) * noise_aug_strength
                    noise = torch.randn_like(resized) * sigma[:, None, None, None]
                    resized = resized + noise
                    resized = torch.clamp(resized, -1.0, 1.0)
                
                prepared_frames[pos] = resized.to(device, dtype=dtype)
        
        # 用 -1 填充（黑色在 [-1,1] 范围是 -1）
        sequence = torch.full((3, num_frames, H, W), -1.0, device=device, dtype=dtype)
        
        for pos, frame_tensor in prepared_frames.items():
            num_frame_images = frame_tensor.shape[1]
            end_pos = min(pos + num_frame_images, num_frames)
            sequence[:, pos:end_pos] = frame_tensor[:, :end_pos-pos]
        
        return sequence
    
    def _generate_preview_frames(self, latents, vae, device, output_mode, target_frame,
                                 frame_range_start, frame_range_end, num_frames, as_list):
        """生成预览帧"""
        import torch
        preview_frames = []
        
        vae.to(device)
        
        if output_mode == "single_frame":
            # 只解码目标帧
            latent_idx = target_frame // 4
            if latent_idx < latents.shape[1]:
                frame_latent = latents[:, latent_idx:latent_idx+1].to(device)
                decoded = vae.decode(frame_latent.unsqueeze(0), device=device, tiled=False)[0]
                # [C, T, H, W] -> [H, W, C]
                frame = decoded[:, 0].permute(1, 2, 0).cpu()
                frame = (frame + 1) / 2  # [-1,1] -> [0,1]
                preview_frames = [frame]
        
        elif output_mode == "frame_range":
            # 解码范围内的所有帧
            for frame_idx in range(frame_range_start, min(frame_range_end + 1, num_frames)):
                latent_idx = frame_idx // 4
                if latent_idx < latents.shape[1]:
                    frame_latent = latents[:, latent_idx:latent_idx+1].to(device)
                    decoded = vae.decode(frame_latent.unsqueeze(0), device=device, tiled=False)[0]
                    frame = decoded[:, 0].permute(1, 2, 0).cpu()
                    frame = (frame + 1) / 2
                    preview_frames.append(frame)
        
        else:  # all_frames
            # 解码所有帧（但只取关键帧避免太多）
            step = max(1, num_frames // 10)  # 最多显示10帧
            for frame_idx in range(0, num_frames, step):
                latent_idx = frame_idx // 4
                if latent_idx < latents.shape[1]:
                    frame_latent = latents[:, latent_idx:latent_idx+1].to(device)
                    decoded = vae.decode(frame_latent.unsqueeze(0), device=device, tiled=False)[0]
                    frame = decoded[:, 0].permute(1, 2, 0).cpu()
                    frame = (frame + 1) / 2
                    preview_frames.append(frame)
        
        if as_list:
            # 返回列表
            return preview_frames
        else:
            # 拼接成视频
            if not preview_frames:
                return torch.zeros(1, 64, 64, 3)
            
            if len(preview_frames) == 1:
                return preview_frames[0].unsqueeze(0)
            else:
                return torch.stack(preview_frames, dim=0)
#endregion

#region 帧掩码创建节点
class bsk_WanVideoFrameMask:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "num_frames": ("INT", {"default": 81, "min": 1, "max": 10000}),
                "mode": (["all", "single", "range", "custom"], {"default": "all"}),
                "single_frame": ("INT", {"default": 40, "min": 0}),
                "range_start": ("INT", {"default": 20, "min": 0}),
                "range_end": ("INT", {"default": 60, "min": 0}),
                "invert": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "custom_indices": ("STRING", {
                    "default": "0,10,20,30",
                    "tooltip": "逗号分隔的帧索引列表"
                }),
            }
        }
    
    RETURN_TYPES = ("WANVIDFRAMEMASK", "IMAGE")
    RETURN_NAMES = ("frame_mask", "visualization")
    FUNCTION = "create_mask"
    CATEGORY = "WanVideoWrapper"
    
    def create_mask(self, num_frames, mode, single_frame, range_start, range_end,
                   invert=False, custom_indices=""):
        import torch
        import numpy as np
        
        mask = torch.zeros(num_frames, dtype=torch.bool)
        
        if mode == "all":
            mask[:] = True
        elif mode == "single":
            if 0 <= single_frame < num_frames:
                mask[single_frame] = True
        elif mode == "range":
            start = max(0, range_start)
            end = min(num_frames - 1, range_end)
            mask[start:end+1] = True
        elif mode == "custom":
            try:
                indices = [int(x.strip()) for x in custom_indices.split(",")]
                for idx in indices:
                    if 0 <= idx < num_frames:
                        mask[idx] = True
            except:
                pass
        
        if invert:
            mask = ~mask
        
        # 创建可视化图像
        vis_height = 64
        vis_width = num_frames * 2  # 每帧2像素宽
        
        vis = np.ones((vis_height, vis_width, 3), dtype=np.float32)
        
        for i in range(num_frames):
            x_start = i * 2
            x_end = (i + 1) * 2
            if mask[i]:
                # 选中的帧显示为绿色
                vis[:, x_start:x_end] = [0, 1, 0]
            else:
                # 未选中的帧显示为灰色
                vis[:, x_start:x_end] = [0.3, 0.3, 0.3]
        
        # 标记帧号
        for i in range(0, num_frames, 10):
            x = i * 2
            cv2.putText(vis, str(i), (x, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (1, 1, 1), 1)
        
        return (mask, torch.from_numpy(vis).unsqueeze(0))
#endregion

#region I2V encode
class bsk_WanVideoImageToVideoEncode:
    @classmethod
    def INPUT_TYPES(s):
        return {"required": {
            "width": ("INT", {"default": 832, "min": 64, "max": 8096, "step": 8, "tooltip": "Width of the image to encode"}),
            "height": ("INT", {"default": 480, "min": 64, "max": 8096, "step": 8, "tooltip": "Height of the image to encode"}),
            "num_frames": ("INT", {"default": 81, "min": 1, "max": 10000, "step": 4, "tooltip": "Number of frames to encode"}),
            "noise_aug_strength": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Strength of noise augmentation, helpful for I2V where some noise can add motion and give sharper results"}),
            "start_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Additional latent multiplier for start frame, helpful for I2V where lower values allow for more motion"}),
            "end_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Additional latent multiplier for end frame, helpful for I2V where lower values allow for more motion"}),
            "force_offload": ("BOOLEAN", {"default": True}),
            },
            "optional": {
                "vae": ("WANVAE",),
                "clip_embeds": ("WANVIDIMAGE_CLIPEMBEDS", {"tooltip": "Clip vision encoded image"}),
                "start_image": ("IMAGE", {"tooltip": "Start frame image (position 0)"}),
                "end_image": ("IMAGE", {"tooltip": "End frame image (last position)"}),
                # 新增三个中间关键帧
                "keyframe1": ("IMAGE", {"tooltip": "Keyframe 1 (position at ~25% of video)"}),
                "keyframe2": ("IMAGE", {"tooltip": "Keyframe 2 (position at ~50% of video)"}),
                "keyframe3": ("IMAGE", {"tooltip": "Keyframe 3 (position at ~75% of video)"}),
                # 每个关键帧的latent strength
                "keyframe1_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Latent strength for keyframe 1"}),
                "keyframe2_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Latent strength for keyframe 2"}),
                "keyframe3_latent_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.001, "tooltip": "Latent strength for keyframe 3"}),
                "control_embeds": ("WANVIDIMAGE_EMBEDS", {"tooltip": "Control signal for the Fun -model"}),
                "fun_or_fl2v_model": ("BOOLEAN", {"default": True, "tooltip": "Enable when using official FLF2V or Fun model"}),
                "temporal_mask": ("MASK", {"tooltip": "mask"}),
                "extra_latents": ("LATENT", {"tooltip": "Extra latents to add to the input front, used for Skyreels A2 reference images"}),
                "tiled_vae": ("BOOLEAN", {"default": False, "tooltip": "Use tiled VAE encoding for reduced memory use"}),
                "add_cond_latents": ("ADD_COND_LATENTS", {"advanced": True, "tooltip": "Additional cond latents WIP"}),
                "augment_empty_frames": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 10.0, "step": 0.01, "tooltip": "EXPERIMENTAL: Augment empty frames with the difference to the start image to force more motion"}),
                "empty_frame_pad_image": ("IMAGE", {"tooltip": "Use this image to pad empty frames instead of gray, used with SVI-shot and SVI 2.0 LoRAs"}),
            }
        }

    RETURN_TYPES = ("WANVIDIMAGE_EMBEDS",)
    RETURN_NAMES = ("image_embeds",)
    FUNCTION = "process"
    CATEGORY = "WanVideoWrapper"

    def _calculate_keyframe_positions(self, num_frames, has_start, has_kf1, has_kf2, has_kf3, has_end):
        """
        计算所有关键帧的精确位置
        将视频帧平均分成4份，计算每个关键帧应该在的位置
        
        返回: dict，包含每个关键帧的位置索引（帧级别）
        """
        positions = {}
        
        # 计算分段大小（将视频分成4份）
        # 使用 num_frames - 1 因为帧索引从0开始
        if num_frames <= 1:
            segment_size = 0
        else:
            segment_size = (num_frames - 1) / 4.0
        
        # 计算每个关键帧的位置
        positions['start'] = 0
        positions['keyframe1'] = round(segment_size * 1)  # 25%位置
        positions['keyframe2'] = round(segment_size * 2)  # 50%位置
        positions['keyframe3'] = round(segment_size * 3)  # 75%位置
        positions['end'] = num_frames - 1  # 最后一帧
        
        # 确保位置在有效范围内
        if num_frames > 1:
            positions['keyframe1'] = min(positions['keyframe1'], num_frames - 2)
            positions['keyframe2'] = min(positions['keyframe2'], num_frames - 2)
            positions['keyframe3'] = min(positions['keyframe3'], num_frames - 2)
        
        # 确保位置顺序正确（避免重叠）
        occupied = set()
        if has_start:
            occupied.add(positions['start'])
        
        if has_kf1:
            # 找到第一个未被占用的位置
            while positions['keyframe1'] in occupied and positions['keyframe1'] < num_frames - 1:
                positions['keyframe1'] += 1
            occupied.add(positions['keyframe1'])
        
        if has_kf2:
            while positions['keyframe2'] in occupied and positions['keyframe2'] < num_frames - 1:
                positions['keyframe2'] += 1
            occupied.add(positions['keyframe2'])
        
        if has_kf3:
            while positions['keyframe3'] in occupied and positions['keyframe3'] < num_frames - 1:
                positions['keyframe3'] += 1
            occupied.add(positions['keyframe3'])
        
        return positions

    def add_noise_to_reference_video(self, image, ratio=None):
        sigma = torch.ones((image.shape[0],)).to(image.device, image.dtype) * ratio
        image_noise = torch.randn_like(image) * sigma[:, None, None, None]
        image_noise = torch.where(image==-1, torch.zeros_like(image), image_noise)
        image = image + image_noise
        return image

    def _prepare_keyframe_image(self, image, H, W, device, dtype, noise_aug_strength):
        """
        准备关键帧图像：调整尺寸、归一化、添加噪声
        返回形状为 [C, T, H, W] 的张量
        """
        if image is None:
            return None, 0
        
        image = image[..., :3]
        if image.shape[1] != H or image.shape[2] != W:
            resized = common_upscale(image.movedim(-1, 1), W, H, "lanczos", "disabled").movedim(0, 1)
        else:
            resized = image.permute(3, 0, 1, 2)  # C, T, H, W
        
        resized = resized * 2 - 1  # 归一化到[-1, 1]
        
        if noise_aug_strength > 0.0:
            resized = self.add_noise_to_reference_video(resized, ratio=noise_aug_strength)
        
        return resized.to(device, dtype=dtype), resized.shape[1]  # 返回图像和帧数

    def process(self, width, height, num_frames, force_offload, noise_aug_strength, 
                start_latent_strength, end_latent_strength, 
                start_image=None, end_image=None, 
                keyframe1=None, keyframe2=None, keyframe3=None,
                keyframe1_latent_strength=1.0, keyframe2_latent_strength=1.0, keyframe3_latent_strength=1.0,
                control_embeds=None, fun_or_fl2v_model=False,
                temporal_mask=None, extra_latents=None, clip_embeds=None, tiled_vae=False, 
                add_cond_latents=None, vae=None, augment_empty_frames=0.0, empty_frame_pad_image=None):

        if vae is None:
            raise ValueError("VAE is required for image encoding.")
        H = height
        W = width

        lat_h = H // vae.upsampling_factor
        lat_w = W // vae.upsampling_factor

        num_frames = ((num_frames - 1) // 4) * 4 + 1
        
        # 检测哪些关键帧存在
        has_start = start_image is not None
        has_kf1 = keyframe1 is not None
        has_kf2 = keyframe2 is not None
        has_kf3 = keyframe3 is not None
        has_end = end_image is not None
        
        # 如果只有结束帧没有起始帧，启用fun_or_fl2v_model模式
        if not has_start and has_end:
            fun_or_fl2v_model = True
        
        # 计算所有关键帧的位置
        kf_positions = self._calculate_keyframe_positions(
            num_frames, has_start, has_kf1, has_kf2, has_kf3, has_end
        )
        
        # 收集所有存在的关键帧信息: (name, position, image, strength)
        keyframes = []
        if has_start:
            keyframes.append(('start', kf_positions['start'], start_image, start_latent_strength))
        if has_kf1:
            keyframes.append(('keyframe1', kf_positions['keyframe1'], keyframe1, keyframe1_latent_strength))
        if has_kf2:
            keyframes.append(('keyframe2', kf_positions['keyframe2'], keyframe2, keyframe2_latent_strength))
        if has_kf3:
            keyframes.append(('keyframe3', kf_positions['keyframe3'], keyframe3, keyframe3_latent_strength))
        if has_end:
            keyframes.append(('end', kf_positions['end'], end_image, end_latent_strength))
        
        # 按位置排序
        keyframes.sort(key=lambda x: x[1])
        
        # ========== 关键修改：保持与原始代码兼容的mask和帧序列构建 ==========
        
        # 计算基础帧数（与原始逻辑一致）
        two_ref_images = has_start and has_end
        base_frames = num_frames + (1 if two_ref_images and not fun_or_fl2v_model else 0)
        
        # ========== 构建mask ==========
        if temporal_mask is None:
            mask = torch.zeros(1, base_frames, lat_h, lat_w, device=device, dtype=vae.dtype)
            # 为起始帧设置mask
            if has_start:
                mask[:, 0:start_image.shape[0]] = 1
            # 为结束帧设置mask
            if has_end:
                mask[:, -end_image.shape[0]:] = 1
            # 为中间关键帧设置mask
            for name, pos, img, strength in keyframes:
                if name not in ['start', 'end'] and img is not None:
                    pos_in_mask = min(pos, mask.shape[1] - 1)
                    end_pos = min(pos + img.shape[0], mask.shape[1])
                    mask[:, pos_in_mask:end_pos] = 1
        else:
            mask = common_upscale(temporal_mask.unsqueeze(1).to(device), lat_w, lat_h, "nearest", "disabled").squeeze(1)
            if mask.shape[0] > base_frames:
                mask = mask[:base_frames]
            elif mask.shape[0] < base_frames:
                mask = torch.cat([mask, torch.zeros(base_frames - mask.shape[0], lat_h, lat_w, device=device)])
            mask = mask.unsqueeze(0).to(device, vae.dtype)

        pixel_mask = mask.clone()

        # ========== 按原始逻辑处理mask扩展 ==========
        # Repeat first frame mask 4 times
        start_mask_repeated = torch.repeat_interleave(mask[:, 0:1], repeats=4, dim=1)
        
        # 处理结束帧mask（与原始逻辑一致）
        if has_end and not fun_or_fl2v_model:
            end_mask_repeated = torch.repeat_interleave(mask[:, -1:], repeats=4, dim=1)
            mask = torch.cat([start_mask_repeated, mask[:, 1:-1], end_mask_repeated], dim=1)
        else:
            mask = torch.cat([start_mask_repeated, mask[:, 1:]], dim=1)

        # Reshape mask into groups of 4 frames -> [C, T, H, W]
        # mask shape: [1, T*4, H, W] -> [1, T, 4, H, W] -> [4, T, H, W]
        mask = mask.view(1, mask.shape[1] // 4, 4, lat_h, lat_w)
        mask = mask.movedim(1, 2)[0]  # C, T, H, W

        # ========== 准备图像帧序列 ==========
        # 准备起始帧
        if has_start:
            resized_start_image, start_num_frames = self._prepare_keyframe_image(
                start_image, H, W, device, vae.dtype, noise_aug_strength)
        
        # 准备结束帧
        if has_end:
            resized_end_image, end_num_frames = self._prepare_keyframe_image(
                end_image, H, W, device, vae.dtype, noise_aug_strength)
        
        # 准备中间关键帧
        prepared_keyframes = []
        for name, pos, img, strength in keyframes:
            if name not in ['start', 'end'] and img is not None:
                prepared_img, num_imgs = self._prepare_keyframe_image(
                    img, H, W, device, vae.dtype, noise_aug_strength)
                prepared_keyframes.append((name, pos, prepared_img, strength, num_imgs))

        # ========== 构建完整的帧序列（与原始逻辑兼容）==========
        if has_start and not has_end:
            zero_frames = torch.zeros(3, num_frames - start_image.shape[0], H, W, device=device, dtype=vae.dtype)
            concatenated = torch.cat([resized_start_image, zero_frames], dim=1)
            del resized_start_image, zero_frames
        elif not has_start and has_end:
            zero_frames = torch.zeros(3, num_frames - end_image.shape[0], H, W, device=device, dtype=vae.dtype)
            concatenated = torch.cat([zero_frames, resized_end_image], dim=1)
            del zero_frames
        elif not has_start and not has_end:
            concatenated = torch.zeros(3, num_frames, H, W, device=device, dtype=vae.dtype)
        else:
            # 有起始帧和结束帧
            if fun_or_fl2v_model:
                zero_frames = torch.zeros(3, num_frames - (start_image.shape[0] + end_image.shape[0]), H, W, device=device, dtype=vae.dtype)
            else:
                zero_frames = torch.zeros(3, num_frames - 1, H, W, device=device, dtype=vae.dtype)
            concatenated = torch.cat([resized_start_image, zero_frames, resized_end_image], dim=1)
            del resized_start_image, zero_frames

        # ========== 将中间关键帧放置到正确位置 ==========
        for name, pos, prepared_img, strength, num_imgs in prepared_keyframes:
            # 确保位置在有效范围内
            end_pos = min(pos + num_imgs, num_frames)
            actual_pos = min(pos, num_frames - 1)
            
            if prepared_img.shape[1] <= num_frames - actual_pos:
                concatenated[:, actual_pos:actual_pos + prepared_img.shape[1]] = prepared_img
            else:
                concatenated[:, actual_pos:num_frames] = prepared_img[:, :num_frames - actual_pos]

        # ========== 处理empty_frame_pad_image ==========
        if empty_frame_pad_image is not None:
            pad_img = empty_frame_pad_image.clone()[..., :3]
            if pad_img.shape[1] != H or pad_img.shape[2] != W:
                pad_img = common_upscale(pad_img.movedim(-1, 1), W, H, "lanczos", "disabled").movedim(1, -1)
            pad_img = (pad_img.movedim(-1, 0) * 2 - 1).to(device, dtype=vae.dtype)

            num_pad_frames = pad_img.shape[1]
            num_target_frames = concatenated.shape[1]
            if num_pad_frames < num_target_frames:
                pad_img = torch.cat([pad_img, pad_img[:, -1:].expand(-1, num_target_frames - num_pad_frames, -1, -1)], dim=1)
            else:
                pad_img = pad_img[:, :num_target_frames]

            frame_is_empty = (pixel_mask[0].mean(dim=(-2, -1)) < 0.5)[:concatenated.shape[1]].clone()
            
            # 标记起始帧和结束帧为非空
            if has_start:
                frame_is_empty[:start_image.shape[0]] = False
            if has_end:
                frame_is_empty[-end_image.shape[0]:] = False
            # 标记中间关键帧为非空
            for name, pos, prepared_img, strength, num_imgs in prepared_keyframes:
                end_pos = min(pos + num_imgs, num_frames)
                frame_is_empty[pos:end_pos] = False

            concatenated[:, frame_is_empty] = pad_img[:, frame_is_empty]

        mm.soft_empty_cache()
        gc.collect()

        # ========== VAE编码 ==========
        vae.to(device)
        y = vae.encode([concatenated], device, end_=(has_end and not fun_or_fl2v_model), tiled=tiled_vae)[0]
        del concatenated

        # ========== 处理extra_latents ==========
        has_ref = False
        if extra_latents is not None:
            samples = extra_latents["samples"].squeeze(0)
            y = torch.cat([samples, y], dim=1)
            mask = torch.cat([torch.ones_like(mask[:, 0:samples.shape[1]]), mask], dim=1)
            num_frames += samples.shape[1] * 4
            has_ref = True
        
        # ========== 应用latent strength ==========
        # 起始帧
        y[:, :1] *= start_latent_strength
        # 结束帧
        y[:, -1:] *= end_latent_strength
        
        # 中间关键帧的latent strength
        for name, pos, prepared_img, strength, num_imgs in prepared_keyframes:
            # latent中的位置 = 帧位置 // 4
            latent_pos = pos // 4
            if latent_pos < y.shape[1]:
                y[:, latent_pos:latent_pos+1] *= strength
        
        if augment_empty_frames > 0.0:
            frame_is_empty = (mask[0].mean(dim=(-2, -1)) < 0.5).view(1, -1, 1, 1)
            y = y[:, :1] + (y - y[:, :1]) * ((augment_empty_frames+1) * frame_is_empty + ~frame_is_empty)

        # Calculate maximum sequence length
        patches_per_frame = lat_h * lat_w // (PATCH_SIZE[1] * PATCH_SIZE[2])
        frames_per_stride = (num_frames - 1) // 4 + (2 if has_end and not fun_or_fl2v_model else 1)
        max_seq_len = frames_per_stride * patches_per_frame

        if add_cond_latents is not None:
            add_cond_latents["ref_latent_neg"] = vae.encode(torch.zeros(1, 3, 1, H, W, device=device, dtype=vae.dtype), device)

        if force_offload:
            vae.model.to(offload_device)
            mm.soft_empty_cache()
            gc.collect()

        # 准备end_image用于返回（如果存在）
        resized_end_image_out = None
        if has_end:
            resized_end_image_out, _ = self._prepare_keyframe_image(end_image, H, W, device, vae.dtype, 0.0)

        # 构建关键帧位置信息用于返回
        keyframe_info = {
            'positions': kf_positions,
            'has_keyframes': {
                'start': has_start,
                'keyframe1': has_kf1,
                'keyframe2': has_kf2,
                'keyframe3': has_kf3,
                'end': has_end
            }
        }

        image_embeds = {
            "image_embeds": y.cpu(),
            "clip_context": clip_embeds.get("clip_embeds", None) if clip_embeds is not None else None,
            "negative_clip_context": clip_embeds.get("negative_clip_embeds", None) if clip_embeds is not None else None,
            "max_seq_len": max_seq_len,
            "num_frames": num_frames,
            "lat_h": lat_h,
            "lat_w": lat_w,
            "control_embeds": control_embeds["control_embeds"] if control_embeds is not None else None,
            "end_image": resized_end_image_out,
            "fun_or_fl2v_model": fun_or_fl2v_model,
            "has_ref": has_ref,
            "add_cond_latents": add_cond_latents,
            "mask": mask.cpu(),
            "keyframe_info": keyframe_info,  # 新增：关键帧位置信息
        }

        return (image_embeds,)
#endregion

class ImageResizeAAA:
    upscale_methods = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image": ("IMAGE",),
                "width": ("INT", { "default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                "height": ("INT", { "default": 512, "min": 0, "max": MAX_RESOLUTION, "step": 1, }),
                "upscale_method": (s.upscale_methods,),
                "keep_proportion": (["stretch", "resize", "pad", "pad_edge", "crop"], { "default": False }),
                "pad_color": ("STRING", { "default": "0, 0, 0", "tooltip": "Color to use for padding."}),
                "crop_position": (["center", "top", "bottom", "left", "right"], { "default": "center" }),
                "divisible_by": ("INT", { "default": 2, "min": 0, "max": 512, "step": 1, }),
                "swap_dimensions": ("BOOLEAN", {"default": False, "label": "Swap Width/Height"}),
                "auto_match_aspect": ("BOOLEAN", {"default": False, "label": "Auto Match Aspect Ratio"}),
                "filename_prefix": ("STRING", {"default": "image", "tooltip": "Prefix for the output filename"}),
            },
            "optional" : {
                "mask": ("MASK",),
                "device": (["cpu", "gpu"],),
            },
             "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "MASK", "STRING")
    RETURN_NAMES = ("IMAGE", "width", "height", "mask", "filename")
    FUNCTION = "resize"
    CATEGORY = "KJNodes/image"
    DESCRIPTION = """
Resizes the image to the specified width and height.  
Size can be retrieved from the input.

Keep proportions keeps the aspect ratio of the image, by  
highest dimension.  
"""

    def resize(self, image, width, height, keep_proportion, upscale_method, divisible_by, pad_color, crop_position, swap_dimensions, auto_match_aspect, filename_prefix, unique_id, device="cpu", mask=None):
        B, H, W, C = image.shape
        
        # 自动匹配宽高比
        if auto_match_aspect:
            input_aspect = W / H
            target_aspect = width / height
            
            # 如果输入和目标的宽高比不一致（横竖方向不同）
            if (input_aspect > 1 and target_aspect < 1) or (input_aspect < 1 and target_aspect > 1):
                width, height = height, width
                print(f"Auto-matched aspect ratio: swapped dimensions to {width}x{height}")
        
        # 手动交换宽度和高度
        if swap_dimensions:
            width, height = height, width
            
        if device == "gpu":
            if upscale_method == "lanczos":
                raise Exception("Lanczos is not supported on the GPU")
            device = model_management.get_torch_device()
        else:
            device = torch.device("cpu")

        if width == 0:
            width = W
        if height == 0:
            height = H
        
        if keep_proportion == "resize" or keep_proportion.startswith("pad"):
            # If one of the dimensions is zero, calculate it to maintain the aspect ratio
            if width == 0 and height != 0:
                ratio = height / H
                new_width = round(W * ratio)
            elif height == 0 and width != 0:
                ratio = width / W
                new_height = round(H * ratio)
            elif width != 0 and height != 0:
                # Scale based on which dimension is smaller in proportion to the desired dimensions
                ratio = min(width / W, height / H)
                new_width = round(W * ratio)
                new_height = round(H * ratio)

            if keep_proportion.startswith("pad"):
                # Calculate padding based on position
                if crop_position == "center":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif crop_position == "top":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = 0
                    pad_bottom = height - new_height
                elif crop_position == "bottom":
                    pad_left = (width - new_width) // 2
                    pad_right = width - new_width - pad_left
                    pad_top = height - new_height
                    pad_bottom = 0
                elif crop_position == "left":
                    pad_left = 0
                    pad_right = width - new_width
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top
                elif crop_position == "right":
                    pad_left = width - new_width
                    pad_right = 0
                    pad_top = (height - new_height) // 2
                    pad_bottom = height - new_height - pad_top

            width = new_width
            height = new_height

        if divisible_by > 1:
            width = width - (width % divisible_by)
            height = height - (height % divisible_by)

        out_image = image.clone().to(device)

        if mask is not None:
            out_mask = mask.clone().to(device)
        
        if keep_proportion == "crop":
            old_width = W
            old_height = H
            old_aspect = old_width / old_height
            new_aspect = width / height
            
            # Calculate dimensions to keep
            if old_aspect > new_aspect:  # Image is wider than target
                crop_w = round(old_height * new_aspect)
                crop_h = old_height
            else:  # Image is taller than target
                crop_w = old_width
                crop_h = round(old_width / new_aspect)
            
            # Calculate crop position
            if crop_position == "center":
                x = (old_width - crop_w) // 2
                y = (old_height - crop_h) // 2
            elif crop_position == "top":
                x = (old_width - crop_w) // 2
                y = 0
            elif crop_position == "bottom":
                x = (old_width - crop_w) // 2
                y = old_height - crop_h
            elif crop_position == "left":
                x = 0
                y = (old_height - crop_h) // 2
            elif crop_position == "right":
                x = old_width - crop_w
                y = (old_height - crop_h) // 2
            
            # Apply crop
            out_image = out_image.narrow(-2, x, crop_w).narrow(-3, y, crop_h)
            if mask is not None:
                out_mask = out_mask.narrow(-1, x, crop_w).narrow(-2, y, crop_h)
        
        out_image = common_upscale(out_image.movedim(-1,1), width, height, upscale_method, crop="disabled").movedim(1,-1)

        if mask is not None:
            if upscale_method == "lanczos":
                out_mask = common_upscale(out_mask.unsqueeze(1).repeat(1, 3, 1, 1), width, height, upscale_method, crop="disabled").movedim(1,-1)[:, :, :, 0]
            else:
                out_mask = common_upscale(out_mask.unsqueeze(1), width, height, upscale_method, crop="disabled").squeeze(1)
            
        if keep_proportion.startswith("pad"):
            if pad_left > 0 or pad_right > 0 or pad_top > 0 or pad_bottom > 0:
                padded_width = width + pad_left + pad_right
                padded_height = height + pad_top + pad_bottom
                if divisible_by > 1:
                    width_remainder = padded_width % divisible_by
                    height_remainder = padded_height % divisible_by
                    if width_remainder > 0:
                        extra_width = divisible_by - width_remainder
                        pad_right += extra_width
                    if height_remainder > 0:
                        extra_height = divisible_by - height_remainder
                        pad_bottom += extra_height
                out_image, _ = ImagePadKJ.pad(self, out_image, pad_left, pad_right, pad_top, pad_bottom, 0, pad_color, "edge" if keep_proportion == "pad_edge" else "color")
                if mask is not None:
                    out_mask = out_mask.unsqueeze(1).repeat(1, 3, 1, 1).movedim(1,-1)
                    out_mask, _ = ImagePadKJ.pad(self, out_mask, pad_left, pad_right, pad_top, pad_bottom, 0, pad_color, "edge" if keep_proportion == "pad_edge" else "color")
                    out_mask = out_mask[:, :, :, 0]

        # 生成文件名
        # 确定图像方向
        if width > height:
            orientation = "H"  # 横图
        elif height > width:
            orientation = "V"  # 竖图
        else:
            orientation = "S"  # 正方形
        
        # 构建文件名
        filename = f"{filename_prefix}_{orientation}"

        if unique_id and PromptServer is not None:
            try:
                num_elements = out_image.numel()
                element_size = out_image.element_size()
                memory_size_mb = (num_elements * element_size) / (1024 * 1024)
                
                PromptServer.instance.send_progress_text(
                    f"<tr><td>Output: </td><td><b>{out_image.shape[0]}</b> x <b>{out_image.shape[2]}</b> x <b>{out_image.shape[1]} | {memory_size_mb:.2f}MB</b></td></tr>",
                    unique_id
                )
            except:
                pass

        return(out_image.cpu(), out_image.shape[2], out_image.shape[1], out_mask.cpu() if mask is not None else torch.zeros(64,64, device=torch.device("cpu"), dtype=torch.float32), filename)
     

NODE_CLASS_MAPPINGS = {
    "bsk_StringMergeWithSwitch": bsk_StringMergeWithSwitch,
    "PromptStringProcessor": PromptStringProcessor,
    "LoraLoaderWithPath": LoraLoaderWithPath,
    "StringRuleProcessor": StringRuleProcessor,
    "StringProcessor": StringProcessor,
    "MultiLineStringEditor": MultiLineStringEditor,
    
    "ComfyUIPanel": ComfyUIPanelNode,
    "bsk_WanVideoImageToVideoEncode": bsk_WanVideoImageToVideoEncode,
    # "bsk_WanVideoImageToVideoEncodeSelective": bsk_WanVideoImageToVideoEncodeSelective,
    "bsk_WanVideoFrameMask": bsk_WanVideoFrameMask,
    "RandomSeedNode": RandomSeedNode,
    "缩放图片aa": ImageResizeAAA,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "bsk_StringMergeWithSwitch": "bsk_String Merge (Switch)",
    "PromptStringProcessor": "bsk_字符替换和清除",
    "LoraLoaderWithPath": "bsk_LoraLoaderWithPath",
    "StringRuleProcessor": "bsk_StringRule",
    "StringProcessor": "bsk_字符串排除,注释 # , 用逗号隔开",
    "MultiLineStringEditor": "bsk_提示词编辑器,ctrl+/ 注释/取消注释,",
    
    "ComfyUIPanel": "ComfyUI Panel",
    "bsk_WanVideoImageToVideoEncode": "bsk_wan3中间帧",
    # "bsk_WanVideoImageToVideoEncodeSelective": "bsk_WanVideoImageToVideoEncode帧选择",
    "bsk_WanVideoFrameMask": "bsk_WanVideoFrameMask",
    "RandomSeedNode": "Random Seed (Panel)",
    "ImageResizeAAA": "缩放图片aa",
}


def setup_api():
    """注册 API 路由"""
    try:
        from aiohttp import web
        from server import PromptServer
        import folder_paths

        server = PromptServer.instance

        @server.routes.get("/comfyui_panel/random_seed")
        async def get_random_seed(request):
            seed = random.randint(0, 0xFFFFFFFFFFFFFFFF)
            response = web.json_response({
                "seed_str": str(seed),
                "success": True
            })
            response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
            return response

        @server.routes.post("/comfyui_panel/random_seed")
        async def post_random_seed(request):
            try:
                data = await request.json()
                min_val = int(data.get("min", 0))
                max_val = int(data.get("max", 0xFFFFFFFFFFFFFFFF))
            except:
                min_val = 0
                max_val = 0xFFFFFFFFFFFFFFFF

            if min_val > max_val:
                min_val, max_val = max_val, min_val

            seed = random.randint(min_val, max_val)
            return web.json_response({
                "seed": seed,
                "seed_str": str(seed),
                "min": min_val,
                "max": max_val,
                "success": True
            })

        @server.routes.get("/comfyui_panel/input_files")
        async def get_input_files(request):
            try:
                input_dir = folder_paths.get_input_directory()
                image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
                files = []
                for f in os.listdir(input_dir):
                    file_path = os.path.join(input_dir, f)
                    if os.path.isfile(file_path):
                        ext = os.path.splitext(f)[1].lower()
                        if ext in image_extensions:
                            stat = os.stat(file_path)
                            files.append({
                                "name": f,
                                "size": stat.st_size,
                                "mtime": stat.st_mtime
                            })
                files.sort(key=lambda x: x['mtime'], reverse=True)
                return web.json_response({
                    "success": True,
                    "files": files,
                    "count": len(files)
                })
            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e),
                    "files": [],
                    "count": 0
                })

        @server.routes.get("/comfyui_panel/output_files")
        async def get_output_files(request):
            """获取输出目录的图片文件列表"""
            try:
                output_dir = folder_paths.get_output_directory()
                image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
                files = []
                for f in os.listdir(output_dir):
                    file_path = os.path.join(output_dir, f)
                    if os.path.isfile(file_path):
                        ext = os.path.splitext(f)[1].lower()
                        if ext in image_extensions:
                            stat = os.stat(file_path)
                            files.append({
                                "name": f,
                                "size": stat.st_size,
                                "mtime": stat.st_mtime
                            })
                files.sort(key=lambda x: x['mtime'], reverse=True)
                return web.json_response({
                    "success": True,
                    "files": files,
                    "count": len(files)
                })
            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e),
                    "files": [],
                    "count": 0
                })

        @server.routes.post("/comfyui_panel/upload_crop")
        async def upload_cropped_image(request):
            try:
                reader = await request.multipart()
                filename = None
                image_data = None
                overwrite = False

                async for field in reader:
                    if field.name == 'image':
                        image_data = await field.read()
                        if field.filename:
                            filename = field.filename
                    elif field.name == 'filename':
                        filename = (await field.read()).decode('utf-8')
                    elif field.name == 'overwrite':
                        overwrite = (await field.read()).decode('utf-8').lower() == 'true'

                if not filename or not image_data:
                    return web.json_response({
                        "success": False,
                        "error": "Missing filename or image data"
                    })

                input_dir = folder_paths.get_input_directory()
                file_path = os.path.join(input_dir, filename)

                with open(file_path, 'wb') as f:
                    f.write(image_data)

                return web.json_response({
                    "success": True,
                    "name": filename,
                    "size": len(image_data),
                    "path": file_path
                })

            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e)
                })

        @server.routes.post("/comfyui_panel/delete_file")
        async def delete_input_file(request):
            try:
                data = await request.json()
                filename = data.get('filename')

                if not filename:
                    return web.json_response({
                        "success": False,
                        "error": "Missing filename"
                    })

                input_dir = folder_paths.get_input_directory()
                file_path = os.path.join(input_dir, filename)

                if not os.path.abspath(file_path).startswith(os.path.abspath(input_dir)):
                    return web.json_response({
                        "success": False,
                        "error": "Invalid file path"
                    })

                if os.path.exists(file_path):
                    os.remove(file_path)
                    return web.json_response({
                        "success": True,
                        "message": f"Deleted {filename}"
                    })
                else:
                    return web.json_response({
                        "success": False,
                        "error": "File not found"
                    })

            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e)
                })

        @server.routes.post("/comfyui_panel/clear_input_files")
        async def clear_input_files(request):
            """清空输入目录中的所有图片文件"""
            try:
                input_dir = folder_paths.get_input_directory()
                image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
                deleted_count = 0
                deleted_files = []
                errors = []

                for f in os.listdir(input_dir):
                    file_path = os.path.join(input_dir, f)
                    if os.path.isfile(file_path):
                        ext = os.path.splitext(f)[1].lower()
                        if ext in image_extensions:
                            try:
                                os.remove(file_path)
                                deleted_count += 1
                                deleted_files.append(f)
                            except Exception as e:
                                errors.append({"file": f, "error": str(e)})

                return web.json_response({
                    "success": True,
                    "deleted_count": deleted_count,
                    "deleted_files": deleted_files,
                    "errors": errors,
                    "message": f"Successfully deleted {deleted_count} file(s) from input directory"
                })

            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e),
                    "deleted_count": 0
                })

        @server.routes.post("/comfyui_panel/clear_output_files")
        async def clear_output_files(request):
            """清空输出目录中的所有图片文件"""
            try:
                output_dir = folder_paths.get_output_directory()
                image_extensions = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}
                deleted_count = 0
                deleted_files = []
                errors = []

                for f in os.listdir(output_dir):
                    file_path = os.path.join(output_dir, f)
                    if os.path.isfile(file_path):
                        ext = os.path.splitext(f)[1].lower()
                        if ext in image_extensions:
                            try:
                                os.remove(file_path)
                                deleted_count += 1
                                deleted_files.append(f)
                            except Exception as e:
                                errors.append({"file": f, "error": str(e)})

                return web.json_response({
                    "success": True,
                    "deleted_count": deleted_count,
                    "deleted_files": deleted_files,
                    "errors": errors,
                    "message": f"Successfully deleted {deleted_count} file(s) from output directory"
                })

            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e),
                    "deleted_count": 0
                })

        @server.routes.get("/comfyui_panel/test")
        async def test_endpoint(request):
            return web.json_response({
                "status": "ok",
                "message": "ComfyUI Panel API is working",
                "version": VERSION
            })
        @server.routes.get("/comfyui_panel/list_models")
        async def list_models(request):
            """获取指定类型的模型文件列表"""
            try:
                # 从查询参数获取模型类型，默认为 checkpoints
                model_type = request.query.get("type", "checkpoints")
                # 支持的模型类型映射到 folder_paths 的目录名
                type_map = {
                    "checkpoints": "checkpoints",
                    "loras": "loras",
                    "vae": "vae",
                    "embeddings": "embeddings",
                    "hypernetworks": "hypernetworks",
                    "controlnet": "controlnet",
                    "upscale_models": "upscale_models",
                }
                folder = type_map.get(model_type, "checkpoints")
                
                # 获取模型文件列表
                files = []
                model_dir = folder_paths.get_folder_paths(folder)[0]
                if os.path.exists(model_dir):
                    for f in os.listdir(model_dir):
                        file_path = os.path.join(model_dir, f)
                        if os.path.isfile(file_path):
                            # 可选：只显示特定扩展名
                            ext = os.path.splitext(f)[1].lower()
                            if ext in ['.ckpt', '.safetensors', '.pt', '.pth']:
                                files.append({
                                    "name": f,
                                    "path": f,  # 相对路径/文件名
                                    "size": os.path.getsize(file_path),
                                    "mtime": os.path.getmtime(file_path)
                                })
                
                files.sort(key=lambda x: x['name'].lower())
                return web.json_response({
                    "success": True,
                    "files": files,
                    "count": len(files),
                    "type": model_type
                })
            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e),
                    "files": []
                })

        @server.routes.get("/comfyui_panel/workflow_files")
        async def get_workflow_files(request):
            """获取工作流文件列表
            
            从用户工作流目录获取 .json 工作流文件列表。
            支持通过查询参数 ?path=xxx 指定自定义目录。
            """
            try:
                # 尝试获取用户指定的工作流目录
                custom_path = request.query.get("path", "")
                
                # 确定工作流目录
                workflow_dir = None
                
                if custom_path and os.path.isdir(custom_path):
                    workflow_dir = custom_path
                else:
                    # 尝试多种方式获取工作流目录
                    # 1. 尝试从 folder_paths 获取
                    try:
                        workflow_paths = folder_paths.get_folder_paths("workflows")
                        if workflow_paths:
                            workflow_dir = workflow_paths[0]
                    except:
                        pass
                    
                    # 2. 尝试用户目录下的 workflows 文件夹
                    if not workflow_dir or not os.path.exists(workflow_dir):
                        # 获取 ComfyUI 根目录
                        try:
                            base_path = folder_paths.base_path
                            user_workflow_dir = os.path.join(base_path, "user", "default", "workflows")
                            if os.path.exists(user_workflow_dir):
                                workflow_dir = user_workflow_dir
                        except:
                            pass
                    
                    # 3. 尝试 ComfyUI 根目录下的 workflows 文件夹
                    if not workflow_dir or not os.path.exists(workflow_dir):
                        try:
                            base_path = folder_paths.base_path
                            root_workflow_dir = os.path.join(base_path, "workflows")
                            if os.path.exists(root_workflow_dir):
                                workflow_dir = root_workflow_dir
                        except:
                            pass
                
                if not workflow_dir or not os.path.exists(workflow_dir):
                    return web.json_response({
                        "success": False,
                        "error": "Workflow directory not found",
                        "files": [],
                        "count": 0,
                        "path": workflow_dir or ""
                    })
                
                # 获取工作流文件列表
                files = []
                for f in os.listdir(workflow_dir):
                    file_path = os.path.join(workflow_dir, f)
                    if os.path.isfile(file_path) and f.endswith('.json'):
                        stat = os.stat(file_path)
                        files.append({
                            "name": f,
                            "path": os.path.join(workflow_dir, f),  # 完整路径
                            "size": stat.st_size,
                            "mtime": stat.st_mtime
                        })
                
                # 按修改时间倒序排列
                files.sort(key=lambda x: x['mtime'], reverse=True)
                
                return web.json_response({
                    "success": True,
                    "files": files,
                    "count": len(files),
                    "path": workflow_dir
                })
                
            except Exception as e:
                return web.json_response({
                    "success": False,
                    "error": str(e),
                    "files": [],
                    "count": 0
                })
                
        # ---------- 新增：面板配置管理 API ----------
        @server.routes.post("/comfyui_panel/save_config")
        async def save_config(request):
            """保存面板配置到插件目录下的 panel 文件夹"""
            try:
                data = await request.json()
                filename = data.get("filename")
                config = data.get("config")

                if not filename or not config:
                    return web.json_response({"success": False, "error": "Missing filename or config"})

                # 确保文件名安全，防止路径遍历
                safe_filename = os.path.basename(filename)
                if not safe_filename.endswith(".json"):
                    safe_filename += ".json"

                # 确保 panel 目录存在
                panel_dir = EXTENSION_DIR / "panel"
                panel_dir.mkdir(exist_ok=True)

                file_path = panel_dir / safe_filename

                # 写入文件
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(config, f, indent=2, ensure_ascii=False)

                return web.json_response({
                    "success": True,
                    "filename": safe_filename,
                    "message": f"Config saved to {safe_filename}"
                })

            except Exception as e:
                return web.json_response({"success": False, "error": str(e)})

        @server.routes.get("/comfyui_panel/list_configs")
        async def list_configs(request):
            """列出 panel 目录下所有 .json 配置文件"""
            try:
                panel_dir = EXTENSION_DIR / "panel"
                if not panel_dir.exists():
                    return web.json_response({"success": True, "files": []})

                files = []
                for f in panel_dir.iterdir():
                    if f.is_file() and f.suffix.lower() == ".json":
                        files.append({
                            "name": f.name,
                            "display": f.stem,  # 去掉 .json 用于显示
                            "mtime": f.stat().st_mtime
                        })

                # 按修改时间倒序排列
                files.sort(key=lambda x: x["mtime"], reverse=True)

                return web.json_response({
                    "success": True,
                    "files": files
                })

            except Exception as e:
                return web.json_response({"success": False, "error": str(e)})

        @server.routes.get("/comfyui_panel/load_config")
        async def load_config(request):
            """读取指定配置文件内容"""
            try:
                filename = request.query.get("name")
                if not filename:
                    return web.json_response({"success": False, "error": "Missing filename"})

                safe_filename = os.path.basename(filename)
                panel_dir = EXTENSION_DIR / "panel"
                file_path = panel_dir / safe_filename

                if not file_path.exists():
                    return web.json_response({"success": False, "error": "File not found"})

                with open(file_path, "r", encoding="utf-8") as f:
                    config = json.load(f)

                return web.json_response({
                    "success": True,
                    "config": config
                })

            except Exception as e:
                return web.json_response({"success": False, "error": str(e)})

        @server.routes.post("/comfyui_panel/delete_config")
        async def delete_config(request):
            """删除指定配置文件"""
            try:
                data = await request.json()
                filename = data.get("filename")
                if not filename:
                    return web.json_response({"success": False, "error": "Missing filename"})

                safe_filename = os.path.basename(filename)
                panel_dir = EXTENSION_DIR / "panel"
                file_path = panel_dir / safe_filename

                if not file_path.exists():
                    return web.json_response({"success": False, "error": "File not found"})

                os.remove(file_path)
                return web.json_response({"success": True, "message": f"Deleted {safe_filename}"})

            except Exception as e:
                return web.json_response({"success": False, "error": str(e)})

        # -----------------------------------------

        print(f"[ComfyUI Panel] ✓ API routes registered successfully!")
        print(f"[ComfyUI Panel] ✓ Endpoints:")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/test")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/random_seed")
        print(f"[ComfyUI Panel]   - POST /comfyui_panel/random_seed")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/input_files")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/output_files")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/list_models")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/workflow_files")
        print(f"[ComfyUI Panel]   - POST /comfyui_panel/upload_crop")
        print(f"[ComfyUI Panel]   - POST /comfyui_panel/delete_file")
        print(f"[ComfyUI Panel]   - POST /comfyui_panel/save_config")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/list_configs")
        print(f"[ComfyUI Panel]   - GET  /comfyui_panel/load_config")
        print(f"[ComfyUI Panel]   - POST /comfyui_panel/delete_config")
        return True

    except Exception as e:
        print(f"[ComfyUI Panel] ✗ Failed to register API: {e}")
        import traceback
        traceback.print_exc()
        return False


try:
    import folder_paths
    import server

    if hasattr(server, 'PromptServer') and hasattr(server.PromptServer, 'instance'):
        setup_api()
    else:
        print("[ComfyUI Panel] Waiting for server initialization...")
        import comfy.model_management
        if hasattr(server.PromptServer, 'instance'):
            setup_api()
        else:
            print("[ComfyUI Panel] Server instance not available, API registration deferred")

except ImportError as e:
    print(f"[ComfyUI Panel] Import error: {e}")
    print("[ComfyUI Panel] Not running in ComfyUI environment, API registration skipped")


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print(f"[ComfyUI Panel] Extension loaded (v{VERSION})")
