// ============================================================
// 全局兼容写法：修复粘贴焦点问题 & 节点函数定义问题
// ============================================================
(function () {
    const checkApp = (callback) => {
        if (window.app) {
            callback(window.app);
        } else {
            setTimeout(() => checkApp(callback), 100);
        }
    };

    checkApp((app) => {
        console.log("BSK Tools: App ready, initializing...");

        // --------------------------------------------------------
        // 辅助函数：确保节点的下载方法存在 (解决 undefined 问题)
        // --------------------------------------------------------
        const ensureDownloadMethod = (node) => {
            if (node.type === "SaveImage" && typeof node.downloadCurrentImages !== 'function') {
                // 只记录最近一次下载的文件名（简化版）
                if (node.lastDownloadedFilename === undefined) {
                    node.lastDownloadedFilename = "";
                }

                // 动态挂载方法，防止报错
                node.downloadCurrentImages = function () {
                    if (!this.imgs || this.imgs.length === 0) {
                        console.log("No images to download");
                        return;
                    }

                    // 只处理第一张（最新生成的）图片
                    const img = this.imgs[0];
                    let currentFilename = `image_0.png`;
                    try {
                        const url = new URL(img.src, window.location.origin);
                        const fname = url.searchParams.get("filename");
                        if (fname) currentFilename = fname;
                    } catch (e) {}

                    // 核心检测：对比当前文件名和最近一次下载的文件名
                    if (currentFilename === this.lastDownloadedFilename) {
                        console.log(`BSK Tools: 重复下载检测 - ${currentFilename} 已下载过`);
                        // alert(`⚠️ 无需重复下载\n文件：${currentFilename}`);
                        return;
                    }

                    // 执行下载（仅下载最新的这张）
                    const link = document.createElement('a');
                    link.href = img.src;
                    link.download = currentFilename;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    // 更新最近一次下载的文件名记录
                    this.lastDownloadedFilename = currentFilename;
                    console.log(`BSK Tools: 成功下载 ${currentFilename}`);
                };

                // 可选：重置最近下载记录的方法
                node.resetLastDownloadRecord = function () {
                    this.lastDownloadedFilename = "";
                    console.log("BSK Tools: 最近下载记录已重置");
                    alert("✅ 下载记录已重置");
                };
            }
        };

        // --------------------------------------------------------
        // 第一部分：注册扩展 (实现 SaveImage 按钮)
        // --------------------------------------------------------
        app.registerExtension({
            name: "BSK.Tools.Extension",
            
            async beforeRegisterNodeDef(nodeType, nodeData, appInstance) {
                if (nodeData.name === "SaveImage") {
                    const onNodeCreated = nodeType.prototype.onNodeCreated;
                    nodeType.prototype.onNodeCreated = function () {
                        const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
                        
                        // 下载按钮
                        this.addWidget("button", "⬇️ Download All", "download", () => {
                            // 点击按钮时也做一次检查
                            ensureDownloadMethod(this);
                            this.downloadCurrentImages();
                        });

                        // 可选：重置最近下载记录按钮
                        this.addWidget("button", "🔄 Reset Record", "reset", () => {
                            ensureDownloadMethod(this);
                            this.resetLastDownloadRecord();
                        });

                        this.setSize(this.computeSize());
                        return r;
                    };
                }
            }
        });

        // --------------------------------------------------------
        // 第二部分：快捷键功能 (修复版)
        // --------------------------------------------------------
        window.addEventListener("keydown", async (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

            const selectedNodes = app.canvas.selected_nodes;
            if (!selectedNodes) return;

            // F: 下载 (修复 undefined 问题 + 极简重复检测)
            if (e.key === "f" || e.key === "F") {
                let triggered = false;
                for (const nodeId in selectedNodes) {
                    const node = selectedNodes[nodeId];
                    if (node.type === "SaveImage") {
                        // 即使扩展还没加载完，这里也会动态补上方法
                        ensureDownloadMethod(node);
                        
                        if (node.downloadCurrentImages) {
                            node.downloadCurrentImages();
                            triggered = true;
                        }
                    }
                }
                if (triggered) e.preventDefault();
            }

            // G: 运行
            if (e.key === "g" || e.key === "G") {
                e.preventDefault();
                try {
                    if (typeof app.queuePrompt === 'function') {
                        app.queuePrompt(0, 1);
                    }
                } catch (err) {
                    console.error("BSK Tools G Error:", err);
                }
            }

            // C: 复制
            if (e.key === "c" || e.key === "C") {
                if (e.ctrlKey || e.metaKey) return;
                for (const nodeId in selectedNodes) {
                    const node = selectedNodes[nodeId];
                    if (node.imgs && node.imgs.length > 0) {
                        const img = node.imgs[0];
                        if (img.src) {
                            try {
                                e.preventDefault();
                                const response = await fetch(img.src);
                                const blob = await response.blob();
                                await navigator.clipboard.write([
                                    new ClipboardItem({ [blob.type]: blob })
                                ]);
                                console.log("Image copied");
                                break;
                            } catch (err) {
                                console.error("Copy Error:", err);
                            }
                        }
                    }
                }
            }

            // V: 粘贴 (增强错误检测版)
            if (e.key === "v" || e.key === "V") {
                if (e.ctrlKey || e.metaKey) return;
                for (const nodeId in selectedNodes) {
                    const node = selectedNodes[nodeId];
                    if (node.type === "LoadImage") {
                        try {
                            e.preventDefault();
                            
                            const clipboardItems = await navigator.clipboard.read();
                            for (const item of clipboardItems) {
                                const imageType = item.types.find(type => type.startsWith("image/"));
                                if (imageType) {
                                    const blob = await item.getType(imageType);
                                    const ext = imageType.split('/')[1] || "png";
                                    const filename = `clipboard_${Date.now()}.${ext}`;
                                    const file = new File([blob], filename, { type: imageType });
                                    const formData = new FormData();
                                    formData.append("image", file);
                                    formData.append("overwrite", "true");

                                    // --- 修改开始 ---
                                    // 尝试两种路径：绝对路径 和 相对路径
                                    // 如果你的环境有子路径（如 https://site.com/comfyui），相对路径更稳妥
                                    let resp = await fetch("/upload/image", { method: "POST", body: formData });
                                    
                                    // 如果绝对路径失败（返回HTML），尝试相对路径
                                    if (!resp.ok || (resp.headers.get("content-type") && resp.headers.get("content-type").indexOf("text/html") !== -1)) {
                                         console.log("Absolute path failed, trying relative path...");
                                         resp = await fetch("upload/image", { method: "POST", body: formData });
                                    }

                                    // 检查最终响应状态
                                    if (!resp.ok) {
                                        const errorText = await resp.text();
                                        console.error("Server returned error:", errorText);
                                        throw new Error(`Upload failed: ${resp.status} ${resp.statusText}`);
                                    }

                                    const data = await resp.json();
                                    // --- 修改结束 ---

                                    const uploadedName = data.name;
                                    const imageWidget = node.widgets.find(w => w.name === "image");
                                    if (imageWidget) {
                                        imageWidget.value = uploadedName;
                                        if (imageWidget.callback) imageWidget.callback(uploadedName);
                                        app.canvas.setDirty(true);
                                    }
                                    break;
                                }
                            }
                        } catch (err) {
                            console.error("Paste Error:", err);
                            alert("粘贴失败: " + err.message + "\n请检查控制台(F12)获取详细报错。");
                        }
                        break;
                    }
                }
            }

        });

        // --------------------------------------------------------
        // 第三部分：多行注释功能 (Ctrl + /)
        // --------------------------------------------------------
        function addCommentFunctionality() {
            document.addEventListener('keydown', function(e) {
                if (e.target.tagName === 'TEXTAREA' && e.ctrlKey && e.key === '/') {
                    e.preventDefault();
                    const textarea = e.target;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const hasSelection = start !== end;
                    
                    if (hasSelection) {
                        handlePromptComment(textarea, start, end);
                    } else {
                        handleLineComment(textarea, start, end);
                    }
                }
            });
        }
        addCommentFunctionality();
        console.log("BSK Tools: All features loaded.");
    });

    // 辅助函数保持不变
    function handleLineComment(textarea, start, end) {
        const text = textarea.value;
        const lines = text.split('\n');
        let currentLine = 0;
        let currentPos = 0;
        
        // 找到当前光标所在的行
        for (let i = 0; i < lines.length; i++) {
            if (currentPos + lines[i].length >= start) { currentLine = i; break; }
            currentPos += lines[i].length + 1;
        }
        
        const trimmedLine = lines[currentLine].trimStart();
        const isCommented = trimmedLine.startsWith('#');
        
        // 记录当前光标在行内的偏移量 (相对于行首)
        const offsetInLine = start - currentPos;
    
        if (isCommented) {
            const leadingSpaces = lines[currentLine].length - lines[currentLine].trimStart().length;
            const spaces = lines[currentLine].substring(0, leadingSpaces);
            const afterHash = trimmedLine.substring(1);
            // 去除注释符号后，可能需要去掉一个空格
            lines[currentLine] = afterHash.startsWith(' ') ? spaces + afterHash.substring(1) : spaces + afterHash;
        } else {
            const leadingSpaces = lines[currentLine].length - lines[currentLine].trimStart().length;
            const spaces = lines[currentLine].substring(0, leadingSpaces);
            // 添加注释符号 "# "
            lines[currentLine] = spaces + '# ' + lines[currentLine].substring(leadingSpaces);
        }
    
        // 更新文本
        textarea.value = lines.join('\n');
        
        // 【关键修复】计算并设置新的光标位置
        let newCursorPos = currentPos; // 重置为当前行首位置
        if (isCommented) {
            // 如果是取消注释，光标通常向前移动 2 个字符 (# 和空格)
            // 但要考虑光标是否在注释符号之后
            newCursorPos += Math.max(0, offsetInLine - 2);
        } else {
            // 如果是添加注释，光标向后移动 2 个字符
            newCursorPos += offsetInLine + 2;
        }
    
        // 显式设置光标位置，防止跳到末尾
        textarea.selectionStart = newCursorPos;
        textarea.selectionEnd = newCursorPos;
    
        // 触发 input 事件
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    

    function handlePromptComment(textarea, start, end) {
        const text = textarea.value;
        const promptInfo = findPromptGroup(text, start, end);
        if (!promptInfo) { handleLineComment(textarea, start, end); return; }
        const { promptStart, promptEnd, promptText, isCommented } = promptInfo;
        let newPromptText;
        if (isCommented) {
            newPromptText = promptText.replace(/^#\s*/, '');
        } else {
            newPromptText = '# ' + promptText.trimStart();
        }
        textarea.value = text.substring(0, promptStart) + newPromptText + text.substring(promptEnd);
        textarea.selectionStart = promptStart;
        textarea.selectionEnd = promptStart + newPromptText.length;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function findPromptGroup(text, start, end) {
        let promptStart = start;
        while (promptStart > 0) {
            const char = text[promptStart - 1];
            if (char === ',' || char === '\n') break;
            promptStart--;
        }
        if (text[promptStart] === ',' || text[promptStart] === '\n') promptStart++;
        while (promptStart < text.length && text[promptStart] === ' ') promptStart++;
        
        let promptEnd = start;
        while (promptEnd < text.length) {
            const char = text[promptEnd];
            if (char === ',' || char === '\n') break;
            promptEnd++;
        }
        const promptText = text.substring(promptStart, promptEnd);
        if (!promptText.trim()) return null;
        const isCommented = promptText.trimStart().startsWith('#');
        return { promptStart, promptEnd, promptText, isCommented };
    }
})();