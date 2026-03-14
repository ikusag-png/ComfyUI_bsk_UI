// panel.js (前端部分 - 改进版)
/**
 * ComfyUI_bsk_UI v3.3
 * 改进版：优化图片裁剪上传逻辑，按需上传+防抖，生成时仅上传变更的图片
 * 新增：支持独立HTML模式运行，可通过输入ComfyUI URL连接
 */
(function() {
  'use strict';

  const CONFIG = {
    INPUT_NODE_TYPES: [
      'LoadImage', 'CLIPTextEncode', 'CLIPTextEncodeSDXL',
      'KSampler', 'KSamplerAdvanced', 'EmptyLatentImage',
      'LatentUpscale', 'CheckpointLoaderSimple', 'LoraLoader',
      'LoraLoaderModelOnly', 'VAEDecode', 'VAEEncode',
      'PrimitiveInt', 'PrimitiveFloat',
    ],
    OUTPUT_NODE_TYPES: ['SaveImage', 'PreviewImage'],
    DISPLAY_OUTPUT_TYPES: ['SaveImage', 'PreviewImage', 'VAEDecode', 'VHS_VideoCombine', 'WanVideo', 'VHS_SaveVideo', 'SaveVideo', 'VideoCombine'],
  };

  function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function isInputNode(classType) { return CONFIG.INPUT_NODE_TYPES.includes(classType); }
  function isOutputNode(classType) { return CONFIG.OUTPUT_NODE_TYPES.includes(classType); }

  function getNodeTitle(node, nodeId) {
    if (node._meta?.title) return node._meta.title;
    const titleMap = {
      'LoadImage': '加载图像', 'CLIPTextEncode': 'CLIP 文本编码',
      'KSampler': 'KSampler 采样器', 'EmptyLatentImage': '空白潜空间',
      'CheckpointLoaderSimple': '检查点加载器', 'SaveImage': '保存图像',
      'PreviewImage': '预览图像', 'LoraLoader': 'LoRA 加载器',
      'PrimitiveInt': '整数', 'PrimitiveFloat': '浮点数',
      'VAEDecode': 'VAE 解码',
    };
    return titleMap[node.class_type] || node.class_type + ' #' + nodeId;
  }

  function inferWidgetType(inputKey, value, classType) {
    const key = inputKey.toLowerCase();
    if (classType === 'PrimitiveInt' && key === 'value') return 'number';
    if (classType === 'PrimitiveFloat' && key === 'value') return 'number';
    if (key.includes('text') || key.includes('prompt')) return 'textarea';
    if (key === 'image') return 'image';
    if (key.includes('image') && !key.includes('output') && !key.includes('filename')) return 'image';
    
    // StringProcessor 和 PromptStringProcessor 的特定字段使用多行文本编辑框
    if (classType === 'StringProcessor' && (key === 'strings_to_remove' || key === 'input_string')) return 'textarea';
    if (classType === 'PromptStringProcessor' && (key === 'prompt' || key === 'rules')) return 'textarea';
    
    // 检测 __value__ 格式的布尔值（错误的保存格式）
    if (typeof value === 'object' && value !== null && value.__value__) {
      const val = value.__value__;
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'boolean' && typeof val[1] === 'boolean') {
        return 'checkbox';
      }
    }
    
    if (typeof value === 'number') {
      // 所有数字类型都使用输入框，不再使用滑竿
      return 'number';
    }
    if (typeof value === 'boolean') return 'checkbox';
    if (typeof value === 'string') {
      // 检测包含换行符的字符串，使用多行文本编辑框
      if (value.includes('\n')) return 'textarea';
      if (key.includes('ckpt_name') || key.includes('sampler') || key.includes('scheduler') || key.includes('filename')) return 'dropdown';
      return 'text';
    }
    if (typeof value === 'object' && value !== null) return 'hidden';
    return 'text';
  }

  // 规范化值：处理 __value__ 格式的错误数据
  function normalizeValue(value) {
    // 检测 __value__ 格式的布尔值（错误的保存格式：同时包含true和false）
    if (typeof value === 'object' && value !== null && value.__value__) {
      const val = value.__value__;
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'boolean' && typeof val[1] === 'boolean') {
        // 如果两个值不同（一个true一个false），默认返回true
        // 如果两个值相同，返回那个值
        return val[0] !== val[1] ? true : val[0];
      }
    }
    return value;
  }

  function formatLabel(key) {
    const labelMap = {
      'seed': '随机种子', 'steps': '采样步数', 'cfg': 'CFG 强度',
      'sampler_name': '采样器', 'scheduler': '调度器', 'denoise': '去噪强度',
      'width': '宽度', 'height': '高度', 'batch_size': '批次大小',
      'text': '文本', 'ckpt_name': '模型', 'filename_prefix': '文件名前缀',
      'image': '图像', 'value': '值',
    };
    return labelMap[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
  }

  async function generateRandomSeed() {
    try {
      const response = await fetch(this.baseUrl + '/comfyui_panel/random_seed?t=' + Date.now());
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.seed_str) {
          const seed = String(data.seed_str);
          console.log('[ComfyUI Panel] Generated seed from API:', seed, 'type:', typeof seed);
          return seed;
        }
      }
    } catch (e) {
      console.warn('[ComfyUI Panel] API not available, using fallback');
    }
    const maxSafeInt = Number.MAX_SAFE_INTEGER;
    const seed = String(Math.floor(Math.random() * maxSafeInt));
    console.log('[ComfyUI Panel] Generated seed (fallback):', seed);
    return seed;
  }

  class ComfyUIPanel {
    constructor() {
      // 动态检测运行环境：是否在ComfyUI前端
      // 优先检查显式的独立模式标志（在独立HTML中设置）
      // 然后检查 app 对象是否存在
      this.isStandaloneMode = window.COMFYUI_PANEL_STANDALONE === true || 
                              (typeof app === 'undefined' || !app.api);
      console.log('[ComfyUI Panel] Running in', this.isStandaloneMode ? 'standalone mode' : 'ComfyUI embedded mode');
      
      this.isConnected = false;
      this.socket = null;
      this.connectionStatus = 'disconnected'; // 'disconnected', 'connecting', 'connected', 'error'
      
      this.panelVisible = false;
      this.workflow = null;
      this.parsedNodes = [];
      this.cardValues = {};
      this.isExecuting = false;
      this.isDownloading = false;  // 下载锁，防止重复下载
      this.isPreviewGenerating = false;  // 标识当前预览是生成过程中的预览图
      this.generatedImages = [];
      this.clientId = null;
      this.activeCards = [];
      this.previewUrl = null;
      this.lastProgress = { current: 0, total: 0 };
      this.imageCropData = {};
      this.globalCropSize = { width: 896, height: 1536 };
      this.linkCropSize = true;
      this.lastDownloadedFile = null;

      // 上一个结果相关（浮动缩略图）
      this.previousResult = null;  // { url, filename, downloaded }
      this.currentResult = null;   // { url, filename, downloaded }

      this.seedNode = null;
      this.seedValue = -1;
      this.seedEnabled = false;
      this.lastGeneratedSeed = null;

      this.outputNodeIds = new Set();
      this.currentPromptId = null;
      this.completedOutputNodes = new Set();
      this.textareaHeights = {};

      // 图库相关
      this.galleryFiles = [];
      this.galleryCurrentIndex = -1;
      this.galleryImageCache = {};  // 缓存已加载的图库图片

      // 视频相关
      this.videoTotalFrames = 0;  // 视频总帧数
      this.videoCurrentFrame = 0;  // 当前帧
      this.videoRate = 16;  // 视频帧率
      this.generatedVideos = [];  // 生成的视频列表
      this.isVideoPreview = false;  // 是否正在预览视频
      this.isVideoGeneration = false;  // 是否正在生成视频（收到VHS_latentpreview事件）
      
      // 视频帧预览相关
      this.previewFrames = [];  // 收集的预览帧（blob URL数组）
      this.frameAnimationId = null;  // 帧动画ID
      this.currentFrameIndex = 0;  // 当前播放的帧索引
      this.framePlaybackRate = 100;  // 帧播放间隔（毫秒）

      // 图像预览缩放和平移
      this.previewZoom = 1;
      this.previewPanX = 0;
      this.previewPanY = 0;
      this.isDraggingPreview = false;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this.dragStartPanX = 0;
      this.dragStartPanY = 0;

      // 标签页相关
      this.tabs = [];
      this.currentTab = null;
      this.tabNodes = {};
      
      // 拖拽滚动相关
      this.isDragScrolling = false;
      this.dragScrollStartY = 0;
      this.dragScrollStartTop = 0;
      this.dragScrollVelocity = 0;
      this.dragScrollLastY = 0;
      this.dragScrollLastTime = 0;
      this.dragScrollAnimationId = null;
      
      // 队列相关
      this.queueRemaining = 0;
      this.queueCheckInterval = null;
      
      // 当前活动面板（用于按钮返回逻辑）
      this.activePanelBtn = null;  // 'addCardBtn', 'settingsMainBtn', 'galleryBtn' 或 null
      
      // 右侧面板隐藏状态（Tab键切换）
      this.rightPanelHidden = false;
      this.savedPreviewWidth = '66.67%';  // 保存隐藏前的预览宽度
      
      // 搜索过滤相关
      this.currentSearchQuery = '';

      // 提示词库相关
      this.promptLibrary = [];  // 提示词库列表 [{id, title, content}]

      // 上游节点连接设置
      this.inputLinkSettings = {};  // 存储用户配置的上游连接设置 { 'nodeId.inputKey': { enabled, linkNodeId, linkOutputIndex, defaultValue, defaultDataType } }
      this.originalInputLinks = {};  // 存储原始工作流中的连接信息（用于重置）
      
      // 卡片级别的连接显示开关状态 { nodeId: showLinks }
      this.cardLinkToggleState = {};
      
      // 输入项的默认值类型配置 { 'nodeId.inputKey': { hasDefaultValue, defaultValue, dataType } }
      this.inputDefaultConfig = {};
      
      // 禁用连接时的替代值设置
      this.inputDisabledValues = {};
      
      // 常用节点输入数据类型字典
      // 格式: { 'class_type': { 'input_name': 'data_type' } }
      // data_type: 'int' | 'float' | 'string' | 'boolean'
      this.nodeTypeInputTypes = {
        // KSampler 系列
        'KSampler': { 'seed': 'int', 'steps': 'int', 'cfg': 'float', 'denoise': 'float' },
        'KSampler (Efficient)': { 'seed': 'int', 'steps': 'int', 'cfg': 'float', 'denoise': 'float' },
        'KSamplerAdvanced': { 'noise_seed': 'int', 'steps': 'int', 'cfg': 'float', 'start_at_step': 'int', 'end_at_step': 'int' },
        
        // ControlNet
        'ControlNetApplyAdvanced': { 'strength': 'float', 'start_percent': 'float', 'end_percent': 'float' },
        'ControlNetApply': { 'strength': 'float' },
        
        // Latent 操作
        'LatentUpscale': { 'width': 'int', 'height': 'int', 'crop': 'string' },
        'LatentUpscaleBy': { 'scale_by': 'float' },
        'LatentCrop': { 'width': 'int', 'height': 'int', 'x': 'int', 'y': 'int' },
        
        // 图像操作
        'ImageScale': { 'width': 'int', 'height': 'int', 'crop': 'string' },
        'ImageScaleBy': { 'scale_by': 'float' },
        'ImageUpscaleWithModel': { 'scale_by': 'float' },
        
        // LoRA
        'LoraLoader': { 'strength_model': 'float', 'strength_clip': 'float' },
        'LoraLoaderWithPath': { 'strength_model': 'float', 'strength_clip': 'float' },
        
        // 常量节点
        'INTConstant': { 'value': 'int' },
        'FloatConstant': { 'value': 'float' },
        'StringConstant': { 'value': 'string' },
        'BooleanConstant': { 'value': 'boolean' },
        
        // WD14 Tagger
        'WD14Tagger|pysssss': { 'threshold': 'float', 'character_threshold': 'float', 'replace_underscore': 'boolean', 'trailing_comma': 'boolean', 'enabled': 'boolean' },
        
        // 其他常用
        'CLIPTextEncode': { 'speak_and_recognation': 'boolean' },
        'VAEDecode': {},
        'VAEEncode': {},
        'LoadImage': {},
        'SaveImage': { 'filename_prefix': 'string' },
        
        // 数学运算
        'SimpleMath+': {},
        'MathExpression': { 'expression': 'string' },
        
        // 字符串处理
        'StringProcessor': { 'match_whole_token': 'boolean' },
        'StringRuleProcessor': {},
        'PromptStringProcessor': {},
        
        // 预览
        'PreviewAny': { 'previewMode': 'boolean' },
        'PreviewImage': {},
      };

      // 主题配置
      this.theme = {
        primaryGradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        backgroundColor: 'linear-gradient(141deg, #e3e3e3 0%, #939393 50%, #dbe8f7 100%)',
        cardBackground: 'rgba(255, 255, 255, 0.04)',
        borderStyle: 'rgba(255, 255, 255, 0.08)',
        accentColor: '#667eea',
        textColor: 'white',
        placeholderColor: 'rgba(255, 255, 255, 0.6)'
      };

      // 初始化 baseUrl
      this.baseUrl = '';
      if (!this.isStandaloneMode && typeof app !== 'undefined' && app.api && app.api.api_base) {
        // ComfyUI 嵌入模式：从 app.api 获取
        this.baseUrl = app.api.api_base;
        if (this.baseUrl.endsWith('/')) {
          this.baseUrl = this.baseUrl.slice(0, -1);
        }
        this.isConnected = true;
        this.connectionStatus = 'connected';
      } else {
        // 独立模式：尝试从 localStorage 恢复上次连接的 URL
        const savedUrl = localStorage.getItem('comfyui_panel_server_url');
        if (savedUrl) {
          this.baseUrl = savedUrl;
        }
      }
      console.log('[ComfyUI Panel] baseUrl:', this.baseUrl, 'isStandaloneMode:', this.isStandaloneMode);

      this.createUI();
      this.bindEvents();
      this.bindKeyboard();
      // 配置加载延迟到首次点击显示面板按钮时触发
      this.configLoaded = false;

      if (this.tabs.length === 0) {
        this.addTab('常用', 'main');
      }

      // 独立模式：不自动连接，让用户手动输入地址连接
      // 这样用户可以更换连接地址
      // if (this.isStandaloneMode && this.baseUrl) {
      //   this.connectToServer(this.baseUrl);
      // }

      console.log('[ComfyUI Panel] Panel initialized');
    }

    // 独立模式：连接到 ComfyUI 服务器
    async connectToServer(url) {
      // 规范化 URL
      let serverUrl = url.trim();
      if (serverUrl.endsWith('/')) {
        serverUrl = serverUrl.slice(0, -1);
      }
      
      this.connectionStatus = 'connecting';
      this.updateConnectionUI();
      
      try {
        // 测试连接
        const response = await fetch(serverUrl + '/system_stats?t=' + Date.now(), {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        // 连接成功
        this.baseUrl = serverUrl;
        this.isConnected = true;
        this.connectionStatus = 'connected';
        
        // 保存到 localStorage
        localStorage.setItem('comfyui_panel_server_url', serverUrl);
        
        // 生成客户端ID
        this.clientId = this.clientId || this.generateClientId();
        
        // 建立 WebSocket 连接
        this.connectWebSocket();
        
        this.updateConnectionUI();
        this.showToast('已连接到 ' + serverUrl);
        
        console.log('[ComfyUI Panel] Connected to server:', serverUrl);
      } catch (e) {
        console.error('[ComfyUI Panel] Connection failed:', e);
        this.isConnected = false;
        this.connectionStatus = 'error';
        this.updateConnectionUI();
        this.showToast('连接失败: ' + e.message);
      }
    }

    // 生成客户端ID
    generateClientId() {
      return 'panel_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }

    // 独立模式：建立 WebSocket 连接
    connectWebSocket() {
      if (!this.baseUrl) return;
      
      // 关闭现有连接
      if (this.socket) {
        this.socket.close();
      }
      
      const wsProtocol = this.baseUrl.startsWith('https') ? 'wss' : 'ws';
      const wsUrl = this.baseUrl.replace(/^https?/, wsProtocol) + '/ws?clientId=' + this.clientId;
      
      console.log('[ComfyUI Panel] Connecting WebSocket:', wsUrl);
      
      try {
        this.socket = new WebSocket(wsUrl);
        // 设置二进制类型为 arraybuffer
        this.socket.binaryType = 'arraybuffer';
        
        this.socket.onopen = () => {
          console.log('[ComfyUI Panel] WebSocket connected');
        };
        
        this.socket.onclose = (event) => {
          console.log('[ComfyUI Panel] WebSocket closed:', event.code, event.reason);
          // 尝试重连
          if (this.isConnected && this.isStandaloneMode) {
            setTimeout(() => this.connectWebSocket(), 3000);
          }
        };
        
        this.socket.onerror = (error) => {
          console.error('[ComfyUI Panel] WebSocket error:', error);
        };
        
        this.socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            this.handleBinaryMessage(event.data);
          } else if (typeof event.data === 'string') {
            try {
              const msg = JSON.parse(event.data);
              this.handleWebSocketMessage(msg);
            } catch (e) {}
          }
        };
      } catch (e) {
        console.error('[ComfyUI Panel] WebSocket connection error:', e);
      }
    }

    // 处理 WebSocket 消息
    handleWebSocketMessage(msg) {
      // console.log('[ComfyUI Panel] WebSocket message:', msg.type);
      
      switch (msg.type) {
        case 'status':
          if (msg.data?.status?.exec_info?.queue_remaining !== undefined) {
            this.queueRemaining = msg.data.status.exec_info.queue_remaining;
            this.updateQueueDisplay();
          }
          break;
        case 'progress':
          if (msg.data) {
            this.updateProgress(msg.data.value, msg.data.max);
          }
          break;
        case 'executing':
          if (msg.data === null || msg.data?.node === null) {
            this.onExecutionComplete();
            this.checkQueueStatus();
          }
          break;
        case 'execution_complete':
          this.onExecutionComplete();
          this.checkQueueStatus();
          break;
        case 'executed':
          if (msg.data) {
            this.handleExecutedMessage(msg.data);
          }
          break;
        case 'execution_error':
          this.onExecutionError(msg.data);
          this.checkQueueStatus();
          break;
        case 'VHS_latentpreview':
          if (msg.data && msg.data.length > 0) {
            this.isVideoGeneration = true;
            this.videoTotalFrames = msg.data.length;
            this.videoRate = msg.data.rate || 16;
            this.clearPreviewFrames();
          }
          break;
        case 'progress_state':
          if (this.isVideoGeneration && this.previewFrames.length > 1) {
            this.startFrameAnimation();
          }
          break;
      }
    }

    // 处理 executed 消息
    handleExecutedMessage(data) {
      const promptId = data.prompt_id;
      const nodeId = data.node;
      const output = data.output;

      if (this.currentPromptId && promptId === this.currentPromptId) {
        if (this.outputNodeIds.has(nodeId)) {
          this.completedOutputNodes.add(nodeId);
        }
      }

      const isOutputNode = this.outputNodeIds.has(nodeId);
      const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.gif'];
      let hasVideoOutput = false;
      
      if (output?.images) {
        for (const img of output.images) {
          const fileName = img.filename.toLowerCase();
          if (videoExtensions.some(ext => fileName.endsWith(ext))) {
            hasVideoOutput = true;
            break;
          }
        }
      }
      
      if (output?.videos || output?.gifs) {
        hasVideoOutput = true;
      }
      
      if (hasVideoOutput) {
        if (output?.images) {
          const videos = [];
          const images = [];
          
          output.images.forEach(img => {
            const fileName = img.filename.toLowerCase();
            const isVideo = videoExtensions.some(ext => fileName.endsWith(ext));
            if (isVideo) {
              videos.push(img);
            } else {
              images.push(img);
            }
          });
          
          if (videos.length > 0) {
            this.onVideosGenerated(videos, nodeId);
          }
          if (images.length > 0 && isOutputNode) {
            this.onImagesGenerated(images, nodeId);
          }
        }
        
        if (output?.videos) {
          this.onVideosGenerated(output.videos, nodeId);
        }
        
        if (output?.gifs) {
          this.onVideosGenerated(output.gifs, nodeId);
        }
      } else if (isOutputNode) {
        if (output?.images) {
          this.onImagesGenerated(output.images, nodeId);
        }
      }
    }

    // 更新连接状态 UI
    updateConnectionUI() {
      const statusEl = document.getElementById('connection-status');
      const urlInput = document.getElementById('server-url-input');
      const connectBtn = document.getElementById('connect-btn');
      const connectionPanel = document.getElementById('connection-panel');
      
      if (!statusEl) return;
      
      switch (this.connectionStatus) {
        case 'connecting':
          statusEl.textContent = '连接中...';
          statusEl.className = 'connection-status connecting';
          if (connectBtn) connectBtn.disabled = true;
          break;
        case 'connected':
          statusEl.textContent = '已连接';
          statusEl.className = 'connection-status connected';
          if (urlInput) urlInput.value = this.baseUrl;
          if (connectBtn) connectBtn.disabled = false;
          // 连接成功后隐藏连接面板
          if (connectionPanel) {
            connectionPanel.classList.remove('visible');
          }
          break;
        case 'error':
          statusEl.textContent = '连接失败';
          statusEl.className = 'connection-status error';
          if (connectBtn) connectBtn.disabled = false;
          break;
        default:
          statusEl.textContent = '未连接';
          statusEl.className = 'connection-status disconnected';
      }
    }

    /**
     * 创建并加载图片，在独立模式下设置 crossOrigin
     * @param {string} src - 图片URL
     * @returns {Promise<HTMLImageElement>}
     */
    loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        // 在独立模式下设置 crossOrigin 以支持跨域图片
        if (this.isStandaloneMode || window.COMFYUI_PANEL_STANDALONE) {
          img.crossOrigin = 'anonymous';
        }
        img.onload = () => resolve(img);
        img.onerror = (e) => reject(new Error(`Failed to load image: ${src}`));
        img.src = src;
      });
    }

    /**
     * 同步创建图片元素，在独立模式下设置 crossOrigin
     * @param {string} src - 图片URL
     * @returns {HTMLImageElement}
     */
    createImageElement(src) {
      const img = new Image();
      // 在独立模式下设置 crossOrigin 以支持跨域图片
      if (this.isStandaloneMode || window.COMFYUI_PANEL_STANDALONE) {
        img.crossOrigin = 'anonymous';
      }
      if (src) img.src = src;
      return img;
    }

    createUI() {
      this.createStyles();
      this.createOpenButton();
      this.createMainPanel();
    }

    createStyles() {
      const style = document.createElement('style');
      style.id = 'comfyui-panel-styles';
      style.textContent = `
        /* 连接状态面板样式 - 独立模式 */
        #connection-panel {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(163deg, #b0b0b9 0%, #89a1b1 50%, #919191 100%);
          z-index: 10001;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        #connection-panel.visible { display: flex; }
        
        .connection-panel-content {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border-radius: 16px;
          padding: 40px;
          max-width: 500px;
          width: 90%;
          text-align: center;
        }
        
        .connection-panel-title {
          color: white;
          font-size: 28px;
          font-weight: 600;
          margin-bottom: 10px;
        }
        
        .connection-panel-subtitle {
          color: rgba(255, 255, 255, 0.7);
          font-size: 14px;
          margin-bottom: 30px;
        }
        
        .connection-input-group {
          display: flex;
          gap: 10px;
          margin-bottom: 20px;
        }
        
        .connection-input-group input {
          flex: 1;
          padding: 12px 16px;
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 8px;
          background: rgba(255, 255, 255, 0.1);
          color: white;
          font-size: 16px;
          outline: none;
          transition: all 0.2s;
        }
        
        .connection-input-group input:focus {
          border-color: #667eea;
          background: rgba(255, 255, 255, 0.15);
        }
        
        .connection-input-group input::placeholder {
          color: rgba(255, 255, 255, 0.5);
        }
        
        .connection-btn {
          padding: 12px 24px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          border: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .connection-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
        }
        
        .connection-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        
        .connection-status {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          border-radius: 20px;
          font-size: 14px;
          margin-top: 20px;
        }
        
        .connection-status::before {
          content: '';
          width: 10px;
          height: 10px;
          border-radius: 50%;
        }
        
        .connection-status.disconnected {
          background: rgba(239, 68, 68, 0.2);
          color: #fca5a5;
        }
        .connection-status.disconnected::before { background: #ef4444; }
        
        .connection-status.connecting {
          background: rgba(234, 179, 8, 0.2);
          color: #fde047;
        }
        .connection-status.connecting::before { 
          background: #eab308; 
          animation: pulse 1s infinite;
        }
        
        .connection-status.connected {
          background: rgba(34, 197, 94, 0.2);
          color: #86efac;
        }
        .connection-status.connected::before { background: #22c55e; }
        
        .connection-status.error {
          background: rgba(239, 68, 68, 0.2);
          color: #fca5a5;
        }
        .connection-status.error::before { background: #ef4444; }
        
        .connection-help {
          color: rgba(255, 255, 255, 0.5);
          font-size: 12px;
          margin-top: 20px;
          line-height: 1.6;
        }
        
        .connection-help code {
          background: rgba(255, 255, 255, 0.1);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
        }

        .connection-links {
          display: flex;
          justify-content: center;
          gap: 16px;
          margin-top: 24px;
          padding-top: 20px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .connection-link {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.1);
          color: rgba(255, 255, 255, 0.7);
          transition: all 0.2s ease;
        }

        .connection-link:hover {
          background: rgba(255, 255, 255, 0.2);
          color: white;
          transform: translateY(-2px);
        }

        .connection-link .link-icon {
          width: 22px;
          height: 22px;
        }

        .settings-links {
          display: flex;
          justify-content: center;
          gap: 12px;
          margin-top: 16px;
          padding-top: 16px;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
        }

        .settings-link {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.6);
          transition: all 0.2s ease;
        }

        .settings-link:hover {
          background: rgba(102, 126, 234, 0.3);
          color: white;
          transform: translateY(-2px);
        }

        .settings-link .link-icon {
          width: 20px;
          height: 20px;
        }

        /* 工具栏连接状态指示器 */
        .toolbar-connection-status {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          background: rgba(0, 0, 0, 0.2);
          border-radius: 4px;
          font-size: 12px;
          color: rgba(255, 255, 255, 0.8);
        }
        
        .toolbar-connection-status .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        
        .toolbar-connection-status.connected .status-dot { background: #22c55e; }
        .toolbar-connection-status.disconnected .status-dot { background: #ef4444; }
        .toolbar-connection-status.connecting .status-dot { background: #eab308; animation: pulse 1s infinite; }
        
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        
        #comfyui-panel-open-btn {
          position: fixed; top: 10px; right: 10px; z-index: 9999;
          width: 40px; height: 40px; padding: 0;
          background: linear-gradient(135deg, rgba(102, 180, 255, 0.6) 0%, rgba(255, 255, 255, 0.5) 100%);
          color: white; border: none; border-radius: 50%; cursor: pointer;
          font-size: 18px; box-shadow: 0 2px 10px rgba(102, 180, 255, 0.4);
          display: flex; align-items: center; justify-content: center;
          backdrop-filter: blur(4px);
          transition: all 0.2s ease;
        }
        #comfyui-panel-open-btn:hover {
          transform: scale(1.1);
          box-shadow: 0 4px 15px rgba(102, 180, 255, 0.6);
        }

        #comfyui-panel-main {
          position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 10000;
          background: ${this.theme.backgroundColor};
          display: none; flex-direction: column;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 16px;
        }
        #comfyui-panel-main.visible { display: flex; }

        /* 整个页面背景图片样式 - 右侧面板使用磨砂效果 */
        .panel-content-bg {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background-size: cover;
          background-position: center;
          background-repeat: no-repeat;
          filter: blur(16px) brightness(1);
          opacity: 0.618;
          z-index: 0;
          pointer-events: none;
          transition: opacity 0.5s ease;
        }
        
        /* 左侧预览窗口背景图样式 - 无磨砂效果 */
        .preview-content-bg {
          position: absolute;
          top: 0; left: 0; right: 0; bottom: 0;
          background-size: cover;
          background-position: center;
          background-repeat: no-repeat;
          filter: blur(3px) brightness(0.618);
          z-index: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
        }
        .panel-content { flex: 1; display: flex; overflow: hidden; position: relative; }
        .panel-content > *:not(.panel-content-bg):not(.preview-content-bg) { position: relative; z-index: 1; }

        .panel-preview {
          display: flex;
          flex-direction: column;
          background: rgba(0, 0, 0, 0.2);
          border-right: 1px solid rgba(255, 255, 255, 0.1);
          flex: 0 0 auto;
          height: 100%;
        }

        .preview-content { flex: 1; display: flex; align-items: center; justify-content: center; padding: 10px; overflow: hidden; min-height: 0; position: relative; }
        .preview-container { position: absolute; top: 10px; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: grab; }
        .preview-container.dragging { cursor: grabbing; }
        .preview-image { background: #ffffff46; width: 100%; height: 100%; object-fit: contain; border-radius: 6px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); transform-origin: 0 0; transition: transform 0.1s ease-out; }
        .preview-image.no-transition { transition: none; }
        .preview-video { width: 100%; height: 100%; object-fit: contain; border-radius: 6px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); }
        .preview-video-info {
          position: absolute;
          top: 12px;
          right: 12px;
          background: rgba(86, 86, 86, 0.6);
          color: rgba(255, 255, 255, 0.9);
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 12px;
          font-family: monospace;
          pointer-events: none;
          z-index: 10;
          backdrop-filter: blur(4px);
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        .preview-video-info.visible { opacity: 1; }
        .preview-placeholder { width: 100%; aspect-ratio: 1; max-width: 350px; background: rgba(255, 255, 255, 0.03); border: 2px dashed rgba(255, 255, 255, 0.15); border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #ffffffb0; }
        
        .preview-zoom-info {
          position: absolute;
          bottom: 12px;
          left: 12px;
          background: rgba(86, 86, 86, 0.6);
          color: rgba(255, 255, 255, 0.9);
          padding: 4px 10px;
          border-radius: 4px;
          font-size: 12px;
          font-family: monospace;
          pointer-events: none;
          z-index: 10;
          backdrop-filter: blur(4px);
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        .preview-zoom-info.visible { opacity: 1; }

        .preview-shortcuts {
          position: absolute;
          bottom: 12px;
          right: 12px;
          background: rgba(86, 86, 86, 0.27);
          color: rgba(255, 255, 255, 0.62);
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          pointer-events: none;
          z-index: 10;
          backdrop-filter: blur(4px);
          transition: opacity 0.3s ease;
          white-space: nowrap;
          line-height: 1.5;
          text-shadow: 2px 5px 6px #3434349c;
        }
        .preview-shortcuts span {
          display: block;
        }
        .preview-shortcuts span strong {
          color: white;
          font-weight: 600;
          margin-right: 4px;
        }

        /* 核心交互：当鼠标悬停在父容器上时隐藏提示 */
        .preview-content:hover .preview-shortcuts {
          opacity: 0;
        }

        /* 上一个结果浮动缩略图 */
        .previous-result-thumb {
          position: absolute;
          top: 10px;
          right: 10px;
          width: 80px;
          height: 80px;
          border-radius: 8px;
          overflow: hidden;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          border: 2px solid rgba(255, 255, 255, 0.2);
          z-index: 50;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(0, 0, 0, 0.3);
        }
        .previous-result-thumb.expanded {
          position: absolute;
          top: 10px;
          right: 10px;
          bottom: 10px;
          left: 10px;
          width: auto;
          height: auto;
          border-color: rgba(102, 126, 234, 0.6);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
          z-index: 60;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        /* 全屏模式下的基础样式 - 高宽40px，但expanded时可以正确展开 */
        .previous-result-thumb.fullscreen-mode {
          width: 40px;
          height: 40px;
          border-radius: 6px;
        }
        .previous-result-thumb.fullscreen-mode.expanded {
          width: auto;
          height: auto;
          border-radius: 8px;
        }
        .previous-result-thumb .thumb-image {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          display: block;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        }
        .previous-result-thumb.expanded .thumb-image {
          position: absolute;
          top: 0;
          left: 0;
          transform: none;
          max-width: none;
          max-height: none;
        }
        .previous-result-thumb .thumb-download-indicator {
          position: absolute;
          bottom: 4px;
          right: 4px;
          width: 20px;
          height: 20px;
          background: rgba(0, 0, 0, 0.6);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          transition: all 0.2s;
        }
        .previous-result-thumb .thumb-download-indicator::after {
          content: '⬇';
          color: #fbbf24;
        }
        .previous-result-thumb.downloaded .thumb-download-indicator::after {
          content: '📋';
          font-size: 10px;
        }
        .previous-result-thumb.downloaded .thumb-download-indicator {
          background: rgba(34, 197, 94, 0.3);
        }

        /* 上一个结果小图标模式（右侧面板隐藏时） - 保留兼容性 */
        .previous-result-thumb.mini {
          width: 40px;
          height: 40px;
          border-radius: 6px;
        }
        .previous-result-thumb.mini .thumb-download-indicator {
          width: 14px;
          height: 14px;
          font-size: 8px;
          bottom: 2px;
          right: 2px;
        }
        .previous-result-thumb.mini .thumb-download-indicator::after {
          font-size: 8px;
        }
        .previous-result-thumb.mini.downloaded .thumb-download-indicator::after {
          font-size: 7px;
        }

        /* 加载图像卡片浮动面板 - 小图标模式 */
        .image-card-float-icon {
          position: absolute;
          right: 10px;
          width: 40px;
          height: 40px;
          border-radius: 6px;
          overflow: hidden;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          border: 2px solid rgba(255, 255, 255, 0.2);
          z-index: 20;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(60, 60, 60, 0.8);
          transition: all 0.2s ease;
        }
        .image-card-float-icon:hover {
          border-color: rgba(102, 126, 234, 0.6);
          transform: scale(1.05);
        }
        .image-card-float-icon .icon-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .image-card-float-icon .icon-label {
          position: absolute;
          bottom: 2px;
          right: 2px;
          background: rgba(0, 0, 0, 0.8);
          color: #ffffff;
          font-size: 9px;
          padding: 1px 3px;
          border-radius: 2px;
          max-width: 36px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
        }

        /* 加载图像卡片浮动面板 - 展开模式 */
        .image-card-float-panel {
          position: fixed;
          top: 0;
          right: 0;
          width: 33.33%;
          height: 100vh;
          background: #ffffff0a;
          backdrop-filter: blur(10px);
          border-left: 1px solid rgba(255, 255, 255, 0.1);
          z-index: 100;
          display: none;
          flex-direction: column;
          overflow: hidden;
        }
        .image-card-float-panel.visible {
          display: flex;
        }
        .image-card-float-panel .float-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          background: #fffefe54;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          flex-shrink: 0;
        }
        .image-card-float-panel .float-header-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .image-card-float-panel .float-title {
          color: white;
          font-size: 14px;
          font-weight: 500;
        }
        .image-card-float-panel .float-pin-btn {
          background: rgba(255, 255, 255, 0.1);
          border: none;
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
          font-size: 14px;
          padding: 4px 8px;
          transition: all 0.2s;
        }
        .image-card-float-panel .float-pin-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          color: white;
        }
        .image-card-float-panel .float-pin-btn.pinned {
          color: #fbbf24;
          transform: rotate(45deg);
        }
        .image-card-float-panel .float-body {
          flex: 1;
          overflow-y: auto;
          padding: 10px;
        }
        .image-card-float-panel .float-body::-webkit-scrollbar {
          width: 6px;
        }
        .image-card-float-panel .float-body::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
        }
        .image-card-float-panel .float-body::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 3px;
        }

        /* 圆形进度指示器 */
        .circular-progress {
          position: absolute;
          top: 20px;
          left: 20px;
          width: 60px;
          height: 60px;
          z-index: 25;
          display: none;
        }
        .circular-progress.visible {
          display: block;
        }
        .circular-progress svg {
          width: 100%;
          height: 100%;
          transform: rotate(-90deg);
        }
        .circular-progress .progress-bg {
          fill: none;
          stroke: rgba(255, 255, 255, 0.1);
          stroke-width: 4;
        }
        .circular-progress .progress-fill {
          fill: none;
          stroke: url(#progress-gradient);
          stroke-width: 4;
          stroke-linecap: round;
          stroke-dasharray: 157;
          stroke-dashoffset: 157;
          transition: stroke-dashoffset 0.3s ease;
        }
        .circular-progress .progress-text {
          position: absolute;
          top: 50%;
          left: 20%;
          transform: translate(-50%, -50%);
          color: white;
          font-size: 12px;
          font-weight: 500;
          font-family: monospace;
        }
        .circular-progress .progress-icon {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          font-size: 20px;
        }

        .progress-container {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          background: rgba(102, 126, 234, 0.15);
          border-top: 1px solid rgba(255, 255, 255, 0.1);
          flex-shrink: 0;
        }
        .progress-bar {
          flex: 1;
          height: 4px;
          background: rgba(255, 255, 255, 0.15);
          border-radius: 2px;
          overflow: hidden;
        }
        .progress-bar-fill {
          height: 100%;
          background: ${this.theme.primaryGradient};
          transition: width 0.3s;
          width: 0%;
        }
        .progress-text {
          color: rgba(255, 255, 255, 0.8);
          font-size: 12px;
          font-family: monospace;
          white-space: nowrap;
          min-width: 60px;
          text-align: right;
        }
        .panel-resizer { width: 4px; background: rgba(255, 255, 255, 0.1); cursor: col-resize; flex-shrink: 0; }
        .panel-resizer:hover, .panel-resizer.dragging { background: rgba(102, 126, 234, 0.5); }

        .panel-drag-handle { position: absolute; top: 50px; left: 0; right: 0; height: 6px; cursor: grab; z-index: 10; display: flex; align-items: center; justify-content: center; }
        .panel-drag-handle::before { content: ''; width: 30px; height: 3px; background: rgba(255, 255, 255, 0.2); border-radius: 2px; }
        .panel-drag-handle:hover::before { background: rgba(102, 126, 234, 0.6); }
        .panel-drag-handle.dragging { cursor: grabbing; }

        .panel-config { flex: 1 1 auto; display: flex; flex-direction: column; min-width: 200px; overflow: hidden; position: relative; }

        .panel-toolbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          background: rgb(4 4 4 / 19%);
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          flex-shrink: 0;
        }
        .panel-toolbar-row {
          display: flex;
          align-items: center;
          flex: 1 1 100%;
          gap: 8px;
        }
        .panel-toolbar-left { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .panel-toolbar-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }
        
        /* 折叠按钮组样式 */
        .collapsible-btn-group { position: relative; display: flex; align-items: center; }
        .collapsible-btn-group .expand-toggle {
          display: flex; align-items: center; justify-content: center;
          min-width: 32px; height: 32px;
          background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px; color: white; cursor: pointer;
          transition: all 0.2s;
        }
        .collapsible-btn-group:hover .expand-toggle { background: rgba(255, 255, 255, 0.2); }
        .collapsible-btn-group .hidden-btns {
          display: none; align-items: center; gap: 6px;
          margin-left: 6px;
        }
        .collapsible-btn-group:hover .hidden-btns { display: flex; }
        .collapsible-btn-group:hover .expand-toggle { display: none; }
        
        /* 有返回状态时保持展开 */
        .collapsible-btn-group.expanded .hidden-btns { display: flex; }
        .collapsible-btn-group.expanded .expand-toggle { display: none; }
        
        /* 左侧按钮组标题文本样式 */
                .collapsible-btn-group .group-title {
                        margin-left: 10px;
                        font-size: 23px;
                        font-weight: 600;
                        
                        /* 1. 添加倾斜效果 */
                        font-style: italic; 
                        
                        color: rgb(241 212 230 / 79%);
                        
                        text-shadow: 0 0 8px rgba(102, 180, 255, 0.8), 0 0 16px rgba(102, 180, 255, 0.5), 0 2px 4px rgba(0, 0, 0, 0.3);
                        text-shadow: 4px 5px 8px rgb(6 6 6 / 88%), 4px 8px 16px rgb(164 225 255 / 41%), 0 2px 4px rgb(0 0 0 / 59%);
                        -webkit-text-stroke: 0.3px rgba(255, 255, 255, 0.5);
                        white-space: nowrap;
                        
                        /* 2. 修改过渡效果 */
                        /* 解释：监听所有属性(包括颜色和阴影)，持续1.2秒，平滑过渡 */
                        transition: all 1.2s ease; 
                }

                /* 3. 这是触发变红发光的关键代码（鼠标悬停时的状态） */
                .collapsible-btn-group:hover .group-title {
                        /* 变成红色 */
                        color: #ff3300; 
                        
                        /* 添加红色发光阴影 (模拟霓虹灯效果) */
                        /* 参数解释: 水平偏移 垂直偏移 模糊半径 颜色 */
                        text-shadow: 0 0 10px #ff3300, 0 0 20px #ff3300, 0 0 40px #ff3300;
                }

                /* 4. 按钮展开后（有返回状态时）标题保持红色发光 */
                .collapsible-btn-group.expanded .group-title {
                        color: #ff3300; 
                        text-shadow: 0 0 10px #ff3300, 0 0 20px #ff3300, 0 0 40px #ff3300;
                }


        .tabs-container {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          overflow-x: auto;
          flex-wrap: wrap;
          flex-shrink: 0;
        }
        .tab {
          padding: 6px 16px; background: rgba(255, 255, 255, 0.1); border-radius: 4px 4px 0 0;
          color: rgba(255, 255, 255, 0.7); font-size: 14px; cursor: pointer; white-space: nowrap;
          transition: all 0.2s;
        }
        .tab.active { background: ${this.theme.primaryGradient}; color: white; }
        .tab-close { margin-left: 8px; font-size: 12px; cursor: pointer; opacity: 0.6; }
        .tab-close:hover { opacity: 1; }

        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; }
        .status-dot.executing { background: #eab308; animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }

        .panel-btn {
          padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer;
          font-size: 14px; font-weight: 500; transition: all 0.2s;
        }
        .panel-btn-primary { background: rgb(235 235 235 / 40%); color: black; border: 1px solid rgb(120 220 220 / 61%); backdrop-filter: blur(8px); box-shadow: 0 2px 8px rgba(120, 220, 220, 0.2); }
        .panel-btn-primary:hover { background: rgba(120, 220, 220, 0.4); transform: scale(1.02); }
        .panel-btn-secondary { background: rgb(196 241 206 / 34%); color: black; border: 1px solid rgba(255, 255, 255, 0.2); }
        .panel-btn-secondary:hover { background: rgba(200, 255, 210, 0.6); }
        .panel-btn-secondary.active-panel { background: rgba(102, 126, 234, 0.3); border-color: rgba(102, 126, 234, 0.5); }
        .panel-btn-danger { background: #ef4444; color: white; }
        .panel-btn-danger:hover { background: #dc2626; }
        .panel-btn-settings { background: rgb(237 249 248 / 21%); color: white; border: 1px solid rgba(255, 182, 193, 0.5); }
        .panel-btn-settings:hover { background: rgba(255, 182, 193, 0.55); }
        .panel-btn-interrupt { background: rgb(255 240 242 / 36%); color: white; border: 1px solid rgba(248, 113, 113, 0.6); }
        .panel-btn-interrupt:hover { background: rgba(248, 113, 113, 0.6); }
        .panel-btn-close { background: rgba(255, 255, 255, 0.1); color: white; border-radius: 50%; min-width: 28px; width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; }
        .panel-btn-close:hover { background: rgba(239, 68, 68, 0.6); }
        .panel-btn-icon { padding: 6px; min-width: 32px; }
        .panel-btn-small { padding: 5px 10px; font-size: 13px; }
        .panel-btn-large { padding: 6px 10px; font-size: 16px; font-weight: bold; }

        .queue-info {
          color: rgb(158 255 193 / 80%);
          font-size: 16px;
          padding: 4px 10px;
          background: rgb(204 255 220 / 25%);
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .queue-info.has-queue {
          background: rgb(84 255 147 / 30%);
          color: #35ff7f;
          text-shadow: 0 0 8px rgba(102, 180, 255, 0.8), 0 0 16px rgba(102, 180, 255, 0.5), 0 2px 4px rgba(0, 0, 0, 0.3);
        }
        #queue-count {
          font-weight: bold;
          min-width: 16px;
          text-align: center;
                  min-height: 23px;
        }

        .toolbar-select {
          padding: 6px 10px; background: #b5b5b5b5;
          border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px;
          color: black; font-size: 13px; cursor: pointer;
        }
        .toolbar-select option { background: #f5f5f5; color: #333; }

        .config-content { flex: 1; padding: 12px; overflow-y: auto; padding-bottom: 20px; cursor: grab; }
        .config-content.preview-dragging { cursor: default; pointer-events: none; }

        .panel-preview { position: relative; }

        /* 提示词库面板样式 - 最大化模式（在 panel-content 下） */
        .prompt-library-panel {
          display: none;
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          flex-direction: row;
          z-index: 100;
        }
        .prompt-library-panel.visible { display: flex; }
        
        /* 深色模式（默认） */
        .prompt-library-panel.dark-mode {
          background: rgba(30, 30, 35, 0.98);
        }
        .prompt-library-panel.dark-mode .prompt-library-left {
          background: rgba(35, 35, 40, 0.95);
        }
        .prompt-library-panel.dark-mode .prompt-preview-header {
          background: #959595cc;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
          border-right: 1px solid rgba(255, 255, 255, 0.1);
        }
        .prompt-library-panel.dark-mode .prompt-preview-title {
          color: #e0e0e0;
        }
        .prompt-library-panel.dark-mode .prompt-preview-textarea {
          background: rgba(38, 38, 38, 0.9);
          color: #e0e0e0;
          caret-color: #667eea;
        }
        .prompt-library-panel.dark-mode .prompt-highlight-pre {
          background: rgb(87 87 87);
          color: #e0e0e0;
        }
        .prompt-library-panel.dark-mode .prompt-library-right {
          background: rgba(35, 35, 40, 0.95);
          border-left: 1px solid rgba(255, 255, 255, 0.1);
        }
        .prompt-library-panel.dark-mode .prompt-section-title {
          color: #a0a0a0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .prompt-library-panel.dark-mode .prompt-item {
          color: #c0c0c0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .prompt-library-panel.dark-mode .prompt-item:hover {
          background: rgba(102, 126, 234, 0.25);
          color: #ffffff;
        }
        .prompt-library-panel.dark-mode .prompt-item.active {
          background: rgb(216 222 251);
          color: #ffffff;
        }
        .prompt-library-panel.dark-mode .prompt-card-item {
          color: #c0c0c0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .prompt-library-panel.dark-mode .prompt-card-item:hover {
          background: rgba(102, 126, 234, 0.25);
          color: #ffffff;
        }
        .prompt-library-panel.dark-mode .prompt-card-item.active {
          background: rgb(216 222 251);
          color: #ffffff;
        }
        .prompt-library-panel.dark-mode .prompt-card-item .card-node-id {
          color: #667eea;
        }
        .prompt-library-panel.dark-mode .prompt-card-item .no-card-hint {
          color: #ef4444;
        }
        .prompt-library-panel.dark-mode .hl-comment {
          color: #6a9955 !important;
        }
        /* 深色模式下的控件样式 */
        .prompt-library-panel.dark-mode .highlight-color-picker {
          border-color: rgba(255, 255, 255, 0.4);
        }
        .prompt-library-panel.dark-mode .font-size-slider {
          background: rgba(255, 255, 255, 0.15);
        }
        .prompt-library-panel.dark-mode .font-size-value {
          color: #c0c0c0;
        }
        .prompt-library-panel.dark-mode .toolbar-select {
          background: rgba(60, 60, 70, 0.9);
          color: #e0e0e0;
          border-color: rgba(255, 255, 255, 0.2);
        }
        .prompt-library-panel.dark-mode .panel-btn-secondary {
          background: rgba(80, 80, 90, 0.8);
          color: #e0e0e0;
          border-color: rgba(255, 255, 255, 0.2);
        }
        .prompt-library-panel.dark-mode .panel-btn-secondary:hover {
          background: rgba(100, 100, 110, 0.9);
        }
        .prompt-library-panel.dark-mode .panel-btn-primary {
          background: rgba(102, 126, 234, 0.6);
          color: #ffffff;
          border-color: rgba(102, 126, 234, 0.8);
        }
        .prompt-library-panel.dark-mode .panel-btn-primary:hover {
          background: rgba(102, 126, 234, 0.8);
        }
        .prompt-library-panel.dark-mode .prompt-card-list-header {
          background: rgba(60, 60, 70, 0.8);
          color: #c0c0c0;
        }
        .prompt-library-panel.dark-mode .prompt-card-list-header .refresh-card-btn {
          background: rgba(102, 126, 234, 0.4);
          color: #a0b0ff;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .prompt-library-panel.dark-mode .prompt-library-list-header {
          background: rgba(60, 60, 70, 0.8);
          color: #c0c0c0;
        }
        .prompt-library-panel.dark-mode .prompt-preview-content {
          background: rgba(35, 35, 40, 0.5);
        }
        
        /* 浅色模式 */
        .prompt-library-panel.light-mode {
          background: rgba(240, 240, 245, 0.98);
        }
        .prompt-library-panel.light-mode .prompt-library-left {
          background: rgba(250, 250, 252, 0.95);
        }
        .prompt-library-panel.light-mode .prompt-preview-header {
          background: rgb(203 203 203 / 22%);
          border-bottom: 1px solid rgba(0, 0, 0, 0.1);
          border-right: 1px solid rgba(0, 0, 0, 0.1);
        }
        .prompt-library-panel.light-mode .prompt-preview-title {
          color: #333;
        }
        .prompt-library-panel.light-mode .prompt-preview-textarea {
          background: rgba(255, 255, 255, 0.9);
          color: #333;
          caret-color: #667eea;
        }
        .prompt-library-panel.light-mode .prompt-highlight-pre {
          background: rgba(255, 255, 255, 0.9);
          color: #333;
        }
        .prompt-library-panel.light-mode .prompt-library-right {
          background: rgba(250, 250, 252, 0.95);
          border-left: 1px solid rgba(0, 0, 0, 0.1);
        }
        .prompt-library-panel.light-mode .prompt-section-title {
          color: #666;
          border-bottom: 1px solid rgba(0, 0, 0, 0.1);
        }
        .prompt-library-panel.light-mode .prompt-item {
          color: #333;
          border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        }
        .prompt-library-panel.light-mode .prompt-item:hover {
          background: rgba(0, 0, 0, 0.05);
        }
        .prompt-library-panel.light-mode .prompt-item.active {
          background: rgba(102, 126, 234, 0.2);
        }
        .prompt-library-panel.light-mode .prompt-card-item {
          color: #333;
          border-bottom: 1px solid rgba(0, 0, 0, 0.05);
        }
        .prompt-library-panel.light-mode .prompt-card-item:hover {
          background: rgba(0, 0, 0, 0.05);
        }
        .prompt-library-panel.light-mode .prompt-card-item.active {
          background: rgba(102, 126, 234, 0.2);
        }
        .prompt-library-panel.light-mode .prompt-card-item .card-node-id {
          color: #667eea;
        }
        .prompt-library-panel.light-mode .prompt-card-item .no-card-hint {
          color: #ef4444;
        }
        .prompt-library-panel.light-mode .hl-comment {
          color: #22863a !important;
        }
        
        /* 提示词库面板停靠模式 - 在 preview-content 里面 */
        .prompt-library-panel.docked {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 100;
        }

        /* 左侧预览区域 */
        .prompt-library-left {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .prompt-preview-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 3px 6px;
          flex-shrink: 0;
        }
        .prompt-preview-title {
          font-size: 23px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .prompt-preview-title .card-id {
          color: #667eea;
          font-family: monospace;
          font-size: 12px;
        }
        .prompt-preview-title .loaded-badge {
          color: #22c55e;
          font-size: 11px;
          margin-left: 4px;
        }
        .prompt-preview-title .no-card-hint {
          color: #ef4444;
          font-size: 11px;
        }
        .prompt-preview-title .unsaved-badge {
          color: #f59e0b;
          font-size: 11px;
          margin-left: 4px;
        }
        .prompt-preview-actions {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .panel-btn-warning {
          background: rgba(245, 158, 11, 0.9) !important;
          color: white !important;
        }
        .panel-btn-warning:hover {
          background: rgba(245, 158, 11, 1) !important;
        }
        .panel-btn-danger-back {
          background: rgba(239, 68, 68, 0.9) !important;
          color: white !important;
        }
        .panel-btn-danger-back:hover {
          background: rgba(239, 68, 68, 1) !important;
        }
        .highlight-color-picker {
          width: 24px;
          height: 24px;
          padding: 0;
          border: 1px solid rgba(255, 255, 255, 0.3);
          border-radius: 4px;
          cursor: pointer;
          background: transparent;
        }
        .highlight-color-picker::-webkit-color-swatch-wrapper {
          padding: 2px;
        }
        .highlight-color-picker::-webkit-color-swatch {
          border-radius: 2px;
          border: none;
        }
        .font-size-slider {
          width: 70px;
          height: 16px;
          -webkit-appearance: none;
          appearance: none;
          background: rgba(0, 0, 0, 0.15);
          border-radius: 8px;
          cursor: pointer;
          outline: none;
        }
        .font-size-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          background: #667eea;
          border-radius: 50%;
          cursor: pointer;
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .font-size-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          background: #667eea;
          border-radius: 50%;
          cursor: pointer;
          border: 2px solid white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        }
        .font-size-value {
          font-size: 11px;
          color: #333;
          min-width: 22px;
          text-align: center;
          font-weight: 500;
        }
        .prompt-preview-content {
          flex: 1;
          padding: 3px;
          overflow: hidden;
          display: flex;
                  background: #ffe7f4c4;
        }
        .prompt-preview-textarea {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: white;
          border: 1px solid rgba(0, 0, 0, 0.15);
          border-radius: 6px;
          color: #333;
          font-size: 23px;
          line-height: 1.6;
          padding: 12px;
          resize: none;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          box-sizing: border-box;
        }
        .prompt-preview-textarea:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.5);
        }
        .prompt-preview-textarea::placeholder {
          color: rgba(0, 0, 0, 0.3);
        }

        /* 提示词库编辑框高亮样式 */
        .prompt-highlight-container {
          position: relative;
          width: 100%;
          height: 100%;
        }
        .prompt-highlight-pre {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          margin: 0;
          padding: 12px;
          border: 1px solid rgba(0, 0, 0, 0.15);
          border-radius: 6px;
          background: white;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 23px;
          line-height: 1.6;
          white-space: pre-wrap;
          word-wrap: break-word;
          overflow: auto;
          pointer-events: none;
          color: #333;
          box-sizing: border-box;
        }
        .prompt-highlight-pre .hl-seg {
          background: rgba(100, 150, 200, 0.15);
        }
        .prompt-highlight-pre .hl-seg.bg-a {
          background: rgba(100, 150, 200, 0.15);
        }
        .prompt-highlight-pre .hl-seg.bg-b {
          background: rgba(200, 150, 100, 0.15);
        }
        .prompt-highlight-pre .hl-comment {
          color: #228b22;
        }
        .prompt-highlight-pre .hl-weighted {
          color: #c04040;
        }
        .prompt-textarea-highlight {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: transparent !important;
          color: transparent !important;
          caret-color: #333;
          z-index: 2;
          box-sizing: border-box;
        }
        .prompt-textarea-highlight::selection {
          background: rgba(102, 126, 234, 0.3);
          color: transparent;
        }

        /* 右侧列表区域 */
        .prompt-library-right {
          width: 280px;
          min-width: 240px;
          max-width: 400px;
          display: flex;
          flex-direction: column;
          background: rgb(255 255 255 / 38%);
          border-left: 1px solid rgba(0, 0, 0, 0.1);
        }
        
        /* 卡片列表区域 - 上方38%高度 */
        .prompt-card-list-container {
          height: 38%;
          min-height: 100px;
          display: flex;
          flex-direction: column;
          border-bottom: 1px solid rgba(0, 0, 0, 0.1);
          flex-shrink: 0;
        }
        .prompt-card-list-header {
          padding: 8px 9px;
          background: rgb(178 227 251 / 36%);
          border-bottom: 1px solid rgba(0, 0, 0, 0.1);
          font-size: 12px;
          font-weight: 500;
          color: #333;
          display: flex;
          align-items: center;
          justify-content: space-between;
          flex-shrink: 0;
        }
        .prompt-card-list-header .refresh-card-btn {
          padding: 2px 6px;
          font-size: 10px;
          background: rgba(102, 126, 234, 0.2);
          border: 1px solid rgba(102, 126, 234, 0.3);
          border-radius: 3px;
          cursor: pointer;
          color: #667eea;
        }
        .prompt-card-list-header .refresh-card-btn:hover {
          background: rgba(102, 126, 234, 0.3);
        }
        .prompt-card-list {
          flex: 1;
          overflow-y: auto;
          padding: 4px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-height: 0;
        }
        .prompt-card-list::-webkit-scrollbar { width: 4px; }
        .prompt-card-list::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.02); border-radius: 2px; }
        .prompt-card-list::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.12); border-radius: 2px; }
        .prompt-card-list::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.2); }
        
        .prompt-card-item {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 8px;
          background: #f0f0f0e0;
          border-radius: 3px;
          border: 1px solid rgba(0, 0, 0, 0.08);
          transition: all 0.15s;
          cursor: pointer;
          font-size: 11px;
        }
        .prompt-card-item:hover, .prompt-card-item.active {
          background: rgba(102, 126, 234, 0.15);
          border-color: rgba(102, 126, 234, 0.4);
        }
        .prompt-card-item .card-node-id {
          color: #667eea;
          font-family: monospace;
          font-size: 10px;
          min-width: 28px;
        }
        .prompt-card-item .card-node-title {
          flex: 1;
          color: #333;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        /* 提示词列表区域 - 下方62%高度 */
        .prompt-library-list-container {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .prompt-library-list-header {
          padding: 8px 9px;
          background: rgb(237 210 228 / 36%);
          border-bottom: 1px solid rgba(0, 0, 0, 0.1);
          font-size: 12px;
          font-weight: 500;
          color: #333;
          flex-shrink: 0;
        }
        .prompt-library-list {
          flex: 1;
          overflow-y: auto;
          padding: 6px;
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-height: 0;
        }
        .prompt-library-list::-webkit-scrollbar { width: 5px; }
        .prompt-library-list::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.03); border-radius: 3px; }
        .prompt-library-list::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.15); border-radius: 3px; }
        .prompt-library-list::-webkit-scrollbar-thumb:hover { background: rgba(0, 0, 0, 0.25); }

        .prompt-item {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 8px;
          background: #f0f0f0e0;
          border-radius: 4px;
          border: 1px solid rgba(0, 0, 0, 0.1);
          transition: all 0.15s;
          cursor: pointer;
        }
        .prompt-item:hover, .prompt-item.active {
          background: rgba(102, 126, 234, 0.15);
          border-color: rgba(102, 126, 234, 0.4);
        }
        .prompt-item-id { color: #667eea; font-size: 10px; font-family: monospace; min-width: 22px; }
        .prompt-item-title { flex: 1; color: #333; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .prompt-item-actions { display: flex; gap: 2px; }
        .prompt-item-actions button { padding: 2px 4px; min-width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.05); border-radius: 3px; border: none; cursor: pointer; }
        .prompt-item-actions button:hover { background: rgba(0,0,0,0.1); }
        .prompt-item-actions button.btn-danger { background: rgba(239, 68, 68, 0.8); color: white; }
        .prompt-item-actions button.btn-danger:hover { background: rgba(239, 68, 68, 1); }
        .prompt-item-actions button svg { width: 10px; height: 10px; }

        .gallery-panel { display: none; flex-direction: column; height: 100%; background: rgba(0, 0, 0, 0.2); min-height: 0; }
        .gallery-panel.visible { display: flex; }
        .gallery-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid rgba(255, 255, 255, 0.1); flex-wrap: wrap; gap: 8px; flex-shrink: 0; }
        .gallery-header span { color: white; font-size: 15px; font-weight: 500; }
        .gallery-header-buttons { display: flex; gap: 6px; }
        .gallery-files { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-wrap: wrap; gap: 10px; align-content: flex-start; min-height: 0; }
        .gallery-files::-webkit-scrollbar { width: 8px; }
        .gallery-files::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.05); border-radius: 4px; }
        .gallery-files::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }
        .gallery-files::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }
        .gallery-item { display: flex; flex-direction: column; background: rgba(255, 255, 255, 0.03); border-radius: 8px; cursor: pointer; color: rgba(255, 255, 255, 0.8); font-size: 12px; transition: all 0.2s; overflow: hidden; border: 2px solid transparent; width: calc(50% - 5px); flex-shrink: 0; }
        .gallery-item:hover { background: rgba(102, 126, 234, 0.2); border-color: rgba(102, 126, 234, 0.4); }
        .gallery-item.selected { background: rgba(102, 126, 234, 0.3); border-color: rgba(102, 126, 234, 0.8); }
        .gallery-item .thumb-wrapper { width: 100%; background: rgba(0, 0, 0, 0.3); display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; }
        .gallery-item .thumb-wrapper img { width: 100%; height: auto; display: block; opacity: 0; transition: opacity 0.3s; }
        .gallery-item .thumb-wrapper img.loaded { opacity: 1; }
        .gallery-item .thumb-wrapper .thumb-placeholder { color: rgba(255, 255, 255, 0.3); font-size: 32px; padding: 40px 0; }
        .gallery-item .thumb-wrapper .video-indicator { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.7); border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; font-size: 16px; }
        .gallery-item .file-info { padding: 8px 10px; background: rgba(0, 0, 0, 0.2); }
        .gallery-item .filename { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
        .gallery-item .filesize { color: rgba(255, 255, 255, 0.5); font-size: 10px; margin-top: 2px; }

        .theme-panel { display: none; flex-direction: column; height: 100%; background: rgba(0, 0, 0, 0.2); overflow-y: auto; }
        .theme-panel.visible { display: flex; }
        .theme-header { padding: 10px 12px; background: rgba(0, 0, 0, 0.3); border-bottom: 1px solid rgba(255, 255, 255, 0.1); color: white; font-weight: 500; font-size: 15px; }
        .theme-content { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
        .theme-item { display: flex; align-items: center; gap: 12px; }
        .theme-item label { width: 120px; color: white; font-size: 13px; }
        .theme-item input[type="color"] { width: 50px; height: 35px; border: none; border-radius: 4px; background: transparent; cursor: pointer; }
        .theme-item input[type="text"] { flex: 1; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; padding: 6px 10px; border-radius: 4px; font-size: 13px; }

        .seed-panel { background: rgba(102, 126, 234, 0.1); border: 1px solid rgba(102, 126, 234, 0.3); border-radius: 6px; margin-bottom: 12px; overflow: hidden; }
        .seed-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(255, 255, 255, 0.03); cursor: pointer; }
        .seed-panel-header:hover { background: rgba(255, 255, 255, 0.06); }
        .seed-panel-title { color: white; font-size: 15px; font-weight: 500; }
        .seed-panel-toggle { color: rgba(255, 255, 255, 0.6); font-size: 18px; transition: transform 0.2s; }
        .seed-panel.collapsed .seed-panel-toggle { transform: rotate(-90deg); }
        .seed-panel.collapsed .seed-panel-body { display: none; }
        .seed-panel-body { padding: 10px 12px; }
        .seed-panel-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .seed-panel input { width: 80px; padding: 6px 8px; font-size: 13px; }
        .seed-generated { color: #22c55e; font-size: 13px; margin-top: 8px; font-family: monospace; }

        .config-card { background: ${this.theme.cardBackground}; border: 1px solid ${this.theme.borderStyle}; border-radius: 6px; margin-bottom: 10px; overflow: hidden; transition: transform 0.2s, box-shadow 0.2s; }
        .config-card.dragging { opacity: 0.8; transform: scale(1.02); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); z-index: 100; }
        .config-card.drop-before { border-top: 3px solid #667eea; }
        .config-card.drop-after { border-bottom: 3px solid #667eea; }
        .config-card-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid ${this.theme.borderStyle}; cursor: grab; }
        .config-card-header:active { cursor: grabbing; }
        .config-card-header:hover { background: rgba(255, 255, 255, 0.06); }
        .config-card-title { color: white; font-size: 15px; font-weight: 500; }
        .config-card-actions { display: flex; gap: 4px; align-items: center; }
        .config-card-actions button { padding: 3px 6px; font-size: 13px; min-width: 26px; }
        .config-card-toggle { color: rgba(255, 255, 255, 0.6); font-size: 18px; padding: 0 8px; cursor: pointer; transition: transform 0.2s; }
        .config-card.collapsed .config-card-toggle { transform: rotate(-90deg); }
        .config-card.collapsed .config-card-body { display: none; }
        .config-card-body { padding: 10px 12px; }

        /* 上游连接开关按钮样式 */
        .toggle-links-btn {
          opacity: 0.5;
        }
        .toggle-links-btn.has-links {
          opacity: 1;
          color: #667eea;
        }
        .toggle-links-btn.active {
          background: rgba(102, 126, 234, 0.3);
          color: #667eea;
        }
        
        /* 卡片连接显示开关样式 */
        .card-link-toggle-btn {
          padding: 2px 6px;
          font-size: 14px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          transition: all 0.2s;
        }
        .card-link-toggle-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        .card-link-toggle-btn.active {
          background: rgba(102, 126, 234, 0.3);
          border-color: rgba(102, 126, 234, 0.5);
          color: #667eea;
        }
        .card-link-toggle-btn.has-links {
          color: #fbbf24;
        }
        
        /* 上游连接控件样式 */
        .upstream-link-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 4px;
          flex-wrap: nowrap;
        }
        .upstream-link-row .link-enable-btn {
          padding: 2px 6px;
          font-size: 14px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          transition: all 0.2s;
          flex-shrink: 0;
        }
        .upstream-link-row .link-enable-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        .upstream-link-row .link-enable-btn.enabled {
          background: #ffffffa1;
          border-color: #ffffff80;
          color: #000000c9;
        }
        .upstream-link-row .link-name-label {
          font-size: 13px;
          color: rgb(20 94 233 / 76%);
          font-weight: 500;
          flex-shrink: 0;
        }
        .upstream-link-row .link-right-group {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-left: auto;
          flex-shrink: 0;
        }
        .upstream-link-row .link-upstream-name {
          font-size: 11px;
          color: #060606d6;
          min-width: 0;
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .upstream-link-row .link-label {
          font-size: 12px;
          color: rgba(255, 255, 255, 0.5);
        }
        .upstream-link-row .link-id-input {
          width: 60px;
          padding: 4px 6px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
        }
        .upstream-link-row .link-id-input:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .upstream-link-row .link-out-input {
          width: 40px;
          padding: 4px 6px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
        }
        .upstream-link-row .link-out-input:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .upstream-link-row .link-reset-btn {
          padding: 2px 6px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
        }
        .upstream-link-row .link-reset-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          color: white;
        }
        .upstream-link-row .link-value-container {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-left: auto;
        }
        .upstream-link-row .link-value-input {
          width: 80px;
          padding: 4px 6px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
        }
        .upstream-link-row .link-value-input:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .upstream-link-row .link-value-btn {
          padding: 4px 10px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.7);
          cursor: pointer;
          min-width: 50px;
          text-align: center;
        }
        .upstream-link-row .link-value-btn.true {
          background: rgba(34, 197, 94, 0.3);
          border-color: rgba(34, 197, 94, 0.5);
          color: #4ade80;
        }
        .upstream-link-row .link-value-btn.false {
          background: rgba(239, 68, 68, 0.3);
          border-color: rgba(239, 68, 68, 0.5);
          color: #f87171;
        }
        
        /* 默认值输入行样式 - 用于显示工作流中的值 */
        .default-value-row {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 4px;
          flex-wrap: wrap;
        }
        .default-datatype-select {
          padding: 3px 6px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
          min-width: 80px;
        }
        .default-datatype-select:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .default-value-input {
          flex: 1;
          min-width: 100px;
          padding: 4px 8px;
          font-size: 13px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
        }
        .default-value-input:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        
        /* 布尔开关按钮样式 */
        .boolean-toggle-btn {
          padding: 4px 12px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.6);
          cursor: pointer;
          transition: all 0.2s;
          min-width: 50px;
        }
        .boolean-toggle-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        .boolean-toggle-btn.true {
          background: rgba(34, 197, 94, 0.3);
          border-color: rgba(34, 197, 94, 0.5);
          color: #4ade80;
        }
        .boolean-toggle-btn.false {
          background: rgba(239, 68, 68, 0.3);
          border-color: rgba(239, 68, 68, 0.5);
          color: #f87171;
        }
        
        /* 卡片显示所有连接时的样式 */
        .config-card.show-all-links .form-group .optional-link {
          display: block !important;
        }
        .config-card:not(.show-all-links) .form-group:not(.has-link) .optional-link {
          display: none;
        }

        /* 上游节点连接设置样式 - 新布局 */
        .input-link-settings {
          margin-top: 4px;
          margin-bottom: 4px;
        }
        .input-link-row {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .link-toggle-btn {
          padding: 2px 6px;
          font-size: 14px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          transition: all 0.2s;
        }
        .link-toggle-btn:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        .link-toggle-btn.enabled {
          background: rgba(102, 126, 234, 0.3);
          border-color: rgba(102, 126, 234, 0.5);
          color: #667eea;
        }
        .link-node-id-input {
          width: 50px;
          padding: 3px 6px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
          text-align: center;
        }
        .link-node-id-input:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .link-node-title {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.6);
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .link-output-index-input {
          width: 40px;
          padding: 3px 4px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 4px;
          color: white;
          text-align: center;
        }
        .link-output-index-input:focus {
          outline: none;
          border-color: rgba(102, 126, 234, 0.6);
        }
        .reset-link-btn {
          padding: 3px 8px;
          font-size: 12px;
          background: rgba(255, 255, 255, 0.1);
          border: 1px solid rgba(255, 255, 255, 0.2);
          border-radius: 4px;
          color: rgba(255, 255, 255, 0.7);
          cursor: pointer;
          transition: all 0.2s;
        }
        .reset-link-btn:hover {
          background: rgba(255, 255, 255, 0.2);
          color: white;
        }
        
        /* 有连接的form-group样式 */
        .form-group.has-link .input-value-container {
          display: none;
        }

        .form-group { margin-bottom: 10px; }
        .form-group:last-child { margin-bottom: 0; }
        .form-group.inline-layout { display: flex; align-items: center; gap: 8px; }
        .form-group.inline-layout .form-label { margin-bottom: 0; flex-shrink: 0; }
        .form-group.inline-layout .form-input { flex: 1; min-width: 0; }
        .form-group.inline-layout .form-input[type="number"] { width: 100px; flex: none; }
        .form-label { display: block; color: ${this.theme.placeholderColor}; font-size: 13px; margin-bottom: 4px; text-transform: uppercase; font-weight: 500; }
        .form-input { width: 100%; padding: 8px 10px; background: #bbbbbb47; border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; color: black; font-size: 14px; box-sizing: border-box; }
        .form-input:focus { outline: none; border-color: rgba(102, 126, 234, 0.6); }
        .form-textarea { min-height: 60px; resize: vertical; font-family: inherit; padding-bottom: 24px; font-size: 14px; line-height: 1.5; }
        .form-textarea::-webkit-scrollbar { width: 8px; }
        .form-textarea::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.05); border-radius: 4px; }
        .form-textarea::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.2); border-radius: 4px; }
        .form-textarea::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.3); }

        /* 语法高亮文本框容器 - 改进版 */
        .textarea-highlight-container {
          position: relative;
          width: 100%;
          min-height: 60px;
        }
        .textarea-highlight-pre {
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          margin: 0;
          padding: 8px 10px;
          border: 1px solid rgba(0, 0, 0, 0.15);
          border-radius: 4px;
          background: white;
          font-family: inherit;
          font-size: 14px;
          line-height: 1.5;
          white-space: pre-wrap;
          word-wrap: break-word;
          overflow: auto;
          pointer-events: none;
          color: #333;
        }
        .textarea-highlight-pre::-webkit-scrollbar { width: 8px; }
        .textarea-highlight-pre::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.05); border-radius: 4px; }
        .textarea-highlight-pre::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.2); border-radius: 4px; }
        .textarea-highlight-pre .hl-seg {
          background: rgba(100, 150, 200, 0.15);
        }
        .textarea-highlight-pre .hl-seg.bg-a {
          background: rgba(100, 150, 200, 0.15);
        }
        .textarea-highlight-pre .hl-seg.bg-b {
          background: rgba(200, 150, 100, 0.15);
        }
        .textarea-highlight-pre .hl-comment {
          color: #228b22;
        }
        .textarea-highlight-pre .hl-weighted {
          color: #c04040;
        }
        .form-textarea-highlight {
          position: relative;
          background: transparent !important;
          color: transparent !important;
          caret-color: #333;
          z-index: 2;
          resize: vertical;
        }
        .form-textarea-highlight::selection {
          background: rgba(102, 126, 234, 0.3);
          color: transparent;
        }

        .config-content::-webkit-scrollbar { width: 6px; }
        .config-content::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.05); }
        .config-content::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 3px; }

        .form-select { width: 100%; padding: 6px 8px; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 4px; color: white; font-size: 13px; cursor: pointer; }
        .form-select option { background: #f5f5f5; color: #333; }

        .image-upload-container { position: relative; border: 2px dashed rgba(255, 255, 255, 0.15); border-radius: 6px; overflow: hidden; min-height: 60px; max-height: 800px; display: flex; justify-content: center; align-items: flex-start; transition: border-color 0.2s, background 0.2s; }
        .image-upload-container:hover { border-color: rgba(102, 126, 234, 0.5); }
        .image-upload-container.has-image { border-style: solid; border-color: rgba(102, 126, 234, 0.3); }
        .image-upload-container.drag-over { border-color: rgba(102, 126, 234, 0.8); background: rgba(102, 126, 234, 0.15); box-shadow: 0 0 10px rgba(102, 126, 234, 0.3); }

        .image-preview-wrapper { position: relative; display: inline-block; vertical-align: top; max-width: 100%; max-height: 800px; }
        .image-preview-wrapper img { display: block; max-width: 100%; max-height: 800px; object-fit: contain; }
        .image-placeholder { padding: 16px; text-align: center; color: rgba(255, 255, 255, 0.4); font-size: 12px; }

        .crop-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; overflow: hidden; }
        .crop-box { position: absolute; border: 2px solid #667eea; background: rgba(102, 126, 234, 0.0); cursor: move; pointer-events: auto; box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5); box-sizing: border-box; }
        .crop-box::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; border: 1px dashed rgba(255, 255, 255, 0.5); }
        .crop-resize-handle { position: absolute; width: 10px; height: 10px; background: #667eea; border: 1px solid white; border-radius: 1px; }
        .crop-resize-handle.nw { top: -5px; left: -5px; cursor: nw-resize; }
        .crop-resize-handle.ne { top: -5px; right: -5px; cursor: ne-resize; }
        .crop-resize-handle.sw { bottom: -5px; left: -5px; cursor: sw-resize; }
        .crop-resize-handle.se { bottom: -5px; right: -5px; cursor: se-resize; }

        .crop-info { display: none; position: absolute; bottom: 4px; left: 4px; background: rgba(0, 0, 0, 0.7); color: white; font-size: 10px; padding: 2px 6px; border-radius: 3px; pointer-events: none; }

        .image-actions { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }

        .crop-settings { display: flex; gap: 4px; margin-top: 6px; align-items: center; flex-wrap: wrap; }
        .crop-settings .crop-width, .crop-settings .crop-height { flex: 1; min-width: 80px; }
        .crop-settings input { padding: 4px 6px; font-size: 12px; }
        .crop-settings .link-btn { padding: 4px 6px; font-size: 10px; }
        .crop-settings .link-btn.active { background: rgba(102, 126, 234, 0.5); }
        .crop-settings .swap-btn { padding: 4px 6px; font-size: 10px; min-width: 28px; }
        .crop-settings .swap-btn:hover { background: rgba(102, 126, 234, 0.4); }
        
        .resolution-preset { display: flex; gap: 4px; margin-top: 6px; align-items: center; }
        .resolution-preset select { padding: 4px 6px; font-size: 12px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; color: white; min-width: 80px; }
        .resolution-preset select option { background: #c5c5c5; color: white; }

        .path-input-group { display: flex; gap: 4px; margin-top: 6px; flex: 1; }
        .path-input-group input { flex: 1; }

        .resolution-path-row { display: flex; gap: 6px; margin-top: 6px; align-items: center; }

        .local-output-settings { margin-top: 4px; padding: 6px 8px; background: rgba(102, 126, 234, 0.08); border-radius: 4px; border: 1px solid rgba(102, 126, 234, 0.15); }
        .local-output-toggle:hover { background: rgba(255, 255, 255, 0.03); border-radius: 4px; }
        .local-output-path input { width: 100%; }

        .empty-state { text-align: center; padding: 20px; color: rgba(255, 255, 255, 0.4); }
        .empty-state-icon { font-size: 32px; margin-bottom: 8px; }
        .empty-state-title { font-size: 14px; font-weight: 500; margin-bottom: 4px; color: rgba(255, 255, 255, 0.6); }

        .settings-panel { display: none; flex-direction: column; height: 100%; }
        .settings-panel.visible { display: contents; }
        .settings-search { padding: 8px; background: rgba(0, 0, 0, 0.2); border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        .settings-search input { width: 100%; padding: 6px 10px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; color: white; font-size: 13px; box-sizing: border-box; }
        .settings-search input::placeholder { color: rgba(255, 255, 255, 0.4); }
        .settings-nodes-container { flex: 1; overflow-y: auto; padding: 8px; }
        .settings-node-item { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(255, 255, 255, 0.03); border-radius: 4px; margin-bottom: 4px; }
        .settings-node-item:hover { background: rgba(255, 255, 255, 0.06); }
        .settings-node-info { flex: 1; min-width: 0; }
        .settings-node-title { color: #e3fff9; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .settings-node-type { color: rgb(255 255 255); font-size: 11px; }

        .add-tab-controls { display: flex; align-items: center; gap: 6px; padding: 10px; background: rgba(0, 0, 0, 0.2); border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
        .add-tab-controls input { flex: 1; padding: 6px 10px; background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 4px; color: white; font-size: 13px; }
        .add-tab-controls button { padding: 6px 12px; font-size: 13px; }

        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: rgba(255, 255, 255, 0.02); }
        ::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.15); border-radius: 2px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.25); }
      `;
      document.head.appendChild(style);
    }

    createOpenButton() {
      const btn = document.createElement('button');
      btn.id = 'comfyui-panel-open-btn';
      btn.innerHTML = '🕮';
      btn.title = '打开控制面板';
      btn.onclick = () => this.show();
      document.body.appendChild(btn);
      this.openBtn = btn;
    }


    createMainPanel() {
      const panel = document.createElement('div');
      panel.id = 'comfyui-panel-main';
      
      // 检查是否是真正的独立模式（显式标志或 app 不存在）
      const isExplicitStandalone = window.COMFYUI_PANEL_STANDALONE === true;
      
      // 独立模式：添加连接面板
      let connectionPanelHTML = '';
      if (isExplicitStandalone) {
        connectionPanelHTML = `
        <!-- 连接面板 - 独立模式 -->
        <div id="connection-panel" class="${this.isConnected ? '' : 'visible'}">
          <div class="connection-panel-content">
            <div class="connection-panel-title">ComfyUI_bsk_UI</div>
            <div class="connection-panel-subtitle">独立运行模式 - 请输入 ComfyUI 服务器地址</div>
            <div class="connection-input-group">
              <input type="text" id="server-url-input" placeholder="http://127.0.0.1:8188" value="${this.baseUrl}">
              <button class="connection-btn" id="connect-btn">连接</button>
            </div>
            <div id="connection-status" class="connection-status ${this.connectionStatus}">${this.connectionStatus === 'connected' ? '已连接' : '未连接'}</div>
            <div class="connection-help">
              <p>请输入 ComfyUI 服务器的地址，例如：</p>
              <p><code>http://127.0.0.1:8188</code> 或 <code>http://192.168.1.100:8188</code></p>
              <p style="margin-top: 12px;">确保 ComfyUI 服务器已启动并允许跨域访问。</p>
            </div>
            <div class="connection-links">
              <a href="https://github.com/ikusag-png/ComfyUI_bsk_UI/" target="_blank" class="connection-link" title="GitHub">
                <svg class="link-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              </a>
              <a href="https://space.bilibili.com/26779709" target="_blank" class="connection-link" title="Bilibili">
                <svg class="link-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z"/></svg>
              </a>
            </div>
          </div>
        </div>`;
      }
      
      panel.innerHTML = `
        ${connectionPanelHTML}
        <div class="panel-content">
          <div class="panel-content-bg" id="panel-content-bg"></div>
          <div class="panel-preview" id="panel-preview">
            <div class="preview-content">
              <div class="preview-content-bg" id="preview-content-bg"></div>
              <div class="preview-container" id="preview-container">
                <div class="preview-zoom-info" id="preview-zoom-info">100%</div>
                <div class="preview-video-info" id="preview-video-info" style="display:none">
                  <span id="video-frame-info">帧: 0/0</span>
                </div>
                <div class="preview-placeholder" id="preview-placeholder">
                  <div style="font-size: 32px; margin-bottom: 8px;">🖼️</div>
                  <div>等待生成</div>
                  <div style="font-size: 11px; margin-top: 8px; opacity: 0.6;">G:生成 F:下载 C:复制</div>
                </div>
                <img class="preview-image" id="preview-image" style="display:none">
                <video class="preview-video" id="preview-video" style="display:none" controls loop muted></video>
                
                <!-- 新增：快捷键提示 -->
                <div class="preview-shortcuts">
                  <span><strong>C</strong> 复制</span>
                  <span><strong>F</strong> 下载/生成</span>
                  <span><strong>G</strong> 生成</span>
                </div>
                
              </div>
              <!-- 上一个结果浮动缩略图 -->
              <div class="previous-result-thumb" id="previous-result-thumb" style="display:none">
                <img class="thumb-image" id="thumb-image">
                <div class="thumb-download-indicator" id="thumb-download-indicator"></div>
              </div>

              <!-- 圆形进度指示器（Tab隐藏右侧面板时显示） -->
              <div class="circular-progress" id="circular-progress">
                <svg viewBox="0 0 60 60">
                  <defs>
                    <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" style="stop-color:#667eea"/>
                      <stop offset="100%" style="stop-color:#764ba2"/>
                    </linearGradient>
                  </defs>
                  <circle class="progress-bg" cx="30" cy="30" r="25"/>
                  <circle class="progress-fill" cx="30" cy="30" r="25"/>
                </svg>
                <span class="progress-text" id="circular-progress-text">0%</span>
              </div>

              <!-- 加载图像卡片浮动面板容器 -->
              <div class="image-card-float-panel" id="image-card-float-panel">
                <div class="float-header">
                  <div class="float-header-left">
                    <span class="float-title" id="float-panel-title">图像加载</span>
                  </div>
                  <button class="float-pin-btn" id="float-panel-pin" title="钉住面板">📌</button>
                </div>
                <div class="float-body" id="float-panel-body"></div>
              </div>

              <!-- 提示词库面板 - 左右布局 -->
              <div class="prompt-library-panel" id="prompt-library-panel">
                <!-- 左侧预览区域 -->
                <div class="prompt-library-left">
                  <div class="prompt-preview-header">
                    <div class="prompt-preview-title" id="prompt-preview-title">
                      <span class="card-id"></span>
                      <span class="card-name"></span>
                    </div>
                    <div class="prompt-preview-actions">
                      <input type="color" class="highlight-color-picker" id="highlight-color-a" value="#6496c8" title="高亮颜色A">
                      <input type="color" class="highlight-color-picker" id="highlight-color-b" value="#c89664" title="高亮颜色B">
                      <input type="color" class="highlight-color-picker" id="editor-bg-color" value="#2a2a2f" title="编辑框背景色">
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="prompt-dark-mode-btn" title="切换深色/浅色模式">🌙</button>
                      <input type="range" class="font-size-slider" id="prompt-font-size" min="13" max="32" value="23" title="字体大小">
                      <span class="font-size-value" id="font-size-value">23</span>
                      <select class="toolbar-select" id="prompt-card-select" style="width: 120px;">
                        <option value="">选择卡片...</option>
                      </select>
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="prompt-refresh-btn" title="刷新">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="23 4 23 10 17 10"></polyline>
                          <polyline points="1 20 1 14 7 14"></polyline>
                          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                      </button>
                      <button class="panel-btn panel-btn-primary panel-btn-icon" id="prompt-save-btn" title="保存为新项">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                          <polyline points="17 21 17 13 7 13 7 21"></polyline>
                          <polyline points="7 3 7 8 15 8"></polyline>
                        </svg>
                      </button>
                      <button class="panel-btn panel-btn-warning panel-btn-icon" id="prompt-overwrite-btn" title="覆盖当前项" style="display: none;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M12 20h9"></path>
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                        </svg>
                      </button>
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="prompt-maximize-btn" title="最大化">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="maximize-icon">
                          <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
                        </svg>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="restore-icon" style="display:none;">
                          <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>
                        </svg>
                      </button>
                      <button class="panel-btn panel-btn-danger-back panel-btn-icon" id="prompt-back-btn" title="返回 (B)">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="9 10 4 15 9 20"></polyline>
                          <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
                        </svg>
                      </button>
                    </div>
                  </div>
                  <div class="prompt-preview-content">
                    <div class="prompt-highlight-container" id="prompt-highlight-container">
                      <pre class="prompt-highlight-pre" id="prompt-highlight-pre"></pre>
                      <textarea class="prompt-preview-textarea prompt-textarea-highlight" id="prompt-preview-textarea" placeholder="将鼠标移动到右侧列表项预览内容，或选择卡片后编辑..."></textarea>
                    </div>
                  </div>
                </div>
                <!-- 右侧列表区域 -->
                <div class="prompt-library-right">
                  <!-- 卡片列表区域 - 上方38%高度 -->
                  <div class="prompt-card-list-container">
                    <div class="prompt-card-list-header">
                      <span>卡片列表</span>
                      <button class="refresh-card-btn" id="refresh-card-list-btn" title="刷新卡片列表">刷新</button>
                    </div>
                    <div class="prompt-card-list" id="prompt-card-list">
                      <!-- 动态生成卡片列表 -->
                    </div>
                  </div>
                  <!-- 提示词列表区域 - 下方62%高度 -->
                  <div class="prompt-library-list-container">
                    <div class="prompt-library-list-header">提示词列表</div>
                    <div class="prompt-library-list" id="prompt-library-list">
                      <!-- 动态生成提示词列表 -->
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="panel-resizer" id="resizer"></div>

          <div class="panel-config" id="panel-config">
            <div class="panel-drag-handle" id="drag-handle"></div>
            
            <div class="panel-toolbar">
              <div class="panel-toolbar-row">
                <div class="panel-toolbar-left">
                  <div class="collapsible-btn-group" id="left-btn-group">
                    <div class="expand-toggle" title="展开工具">☰</div>
                    <div class="hidden-btns">
                      <button class="panel-btn panel-btn-primary panel-btn-icon" id="add-card-btn" title="添加卡片到当前标签">➕</button>
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="collapse-all-btn" title="折叠所有卡片">▲</button>
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="expand-all-btn" title="展开所有卡片">▼</button>
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="prompt-library-btn" title="提示词库">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                          <line x1="8" y1="7" x2="16" y2="7"></line>
                          <line x1="8" y1="11" x2="14" y2="11"></line>
                        </svg>
                      </button>
                      <button class="panel-btn panel-btn-secondary panel-btn-icon" id="gallery-btn" title="图库">🖼</button>
                    </div>
                    <span class="group-title">小暗X</span>
                  </div>
                </div>
                <div class="panel-toolbar-right">
                  <button class="panel-btn panel-btn-secondary panel-btn-icon" id="download-btn" title="下载当前图片 (F)">📥︎</button>
                  <button class="panel-btn panel-btn-primary panel-btn-icon" id="generate-btn" title="运行 (G)" style="width: 39px">▶</button>
                  <button class="panel-btn panel-btn-interrupt panel-btn-icon" id="interrupt-btn" title="中断当前任务">⏹</button>
                                  <button class="panel-btn panel-btn-secondary panel-btn-icon" id="clear-queue-btn" title="清空队列">♻︎</button>
                  <span class="queue-info" id="queue-info" title="队列中待执行的任务数"><span id="queue-count">0</span></span>
                  <button class="panel-btn panel-btn-settings panel-btn-icon" id="settings-main-btn" title="设置">⚙️</button>
                  <button class="panel-btn panel-btn-close" id="close-btn" title="关闭">❌︎</button>
                </div>
              </div>
            </div>

            <div class="tabs-container" id="tabs-container"></div>

            <div class="config-content" id="config-content">
              <div class="seed-panel" id="seed-panel">
                <div class="seed-panel-header" id="seed-panel-header">
                  <span class="seed-panel-title">🎲 随机种子</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <label style="display: flex; align-items: center; gap: 4px; color: white; font-size: 12px;">
                      <input type="checkbox" id="seed-enabled" style="width: 14px; height: 14px;">
                      启用
                    </label>
                    <span class="seed-panel-toggle">▼</span>
                  </div>
                </div>
                <div class="seed-panel-body">
                  <div class="seed-panel-row">
                    <select class="toolbar-select" id="seed-node-select" style="flex: 1;">
                      <option value="">选择节点...</option>
                    </select>
                    <input type="text" class="form-input" id="seed-value" value="-1" style="width: 140px;" title="-1 表示随机，支持任意长度整数或文本">
                    <button class="panel-btn panel-btn-secondary panel-btn-small" id="seed-random-btn">🎲</button>
                  </div>
                  <div class="seed-generated" id="seed-generated" style="display: none;"></div>
                </div>
              </div>

              <div id="config-cards"></div>
            </div>

            <!-- 进度条 -->
            <div class="progress-container" id="progress-container">
              <div class="progress-bar">
                <div class="progress-bar-fill" id="progress-fill"></div>
              </div>
              <span class="progress-text" id="progress-text">0 / 0</span>
            </div>

            <!-- 设置面板 -->
            <div class="settings-panel" id="settings-panel">
              <div class="settings-search">
                <input type="text" id="node-search" placeholder="搜索节点...">
              </div>
              <div class="settings-nodes-container" id="settings-nodes"></div>
            </div>

            <!-- 主设置面板 -->
            <div class="theme-panel" id="main-settings-panel">
              <div class="theme-header">⚙️ 设置面板</div>
              <div class="theme-content">
                <div class="form-group">
                  <label class="form-label">上传 API 工作流</label>
                  <input type="file" id="workflow-file" accept=".json" style="display:none">
                  <div style="display: flex; gap: 8px;">
                    <button class="panel-btn panel-btn-secondary" id="upload-workflow-btn" style="flex: 1;">📁 选择文件</button>
                    <button class="panel-btn panel-btn-warning" id="reboot-btn" title="重启 ComfyUI (需要安装 ComfyUI Manager)">🔄 重启</button>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">服务器配置</label>
                  <select class="toolbar-select" id="server-config-select" style="width: 100%;">
                    <option value="">-- 选择配置 --</option>
                  </select>
                </div>
                <div style="display: flex; gap: 8px;">
                  <button class="panel-btn panel-btn-secondary" id="load-config-btn" style="flex: 1;">📂 加载</button>
                  <button class="panel-btn panel-btn-secondary" id="save-config-btn" style="flex: 1;">💾 保存</button>
                  <button class="panel-btn panel-btn-secondary" id="save-as-btn" style="flex: 1;">📄 另存</button>
                </div>
                <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 16px 0;">
                <button class="panel-btn panel-btn-secondary" id="gallery-btn" style="width: 100%;">🖼️ 打开图库</button>
                <button class="panel-btn panel-btn-secondary" id="theme-btn" style="width: 100%; margin-top: 8px;">🎨 主题编辑</button>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                  <input type="text" class="form-input" id="new-tab-name" placeholder="新标签名称" style="flex: 1;">
                  <button class="panel-btn panel-btn-secondary" id="add-tab-btn">添加</button>
                </div>
                
                <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 16px 0;">
                
                <div class="shortcuts-section">
                  <label class="form-label">快捷键说明</label>
                  <div class="shortcuts-list" style="font-size: 18px; color: rgba(255,255,255,0.8); line-height: 1.8;">
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">G</strong> 生成</span>
                      <span><strong style="color: #6ee7b7;">F</strong> 下载当前图片</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">C</strong> 复制当前图片</span>
                      <span><strong style="color: #6ee7b7;">V</strong> 粘贴图片</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">B</strong> 提示词库</span>
                      <span><strong style="color: #6ee7b7;">ESC</strong> 关闭面板</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">Ctrl+Enter</strong> 生成</span>
                      <span><strong style="color: #6ee7b7;">Z/X</strong> 图库切换</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">Ctrl+双击</strong> 注释/取消注释</span>
                      <span><strong style="color: #6ee7b7;">双击</strong> 选词</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">Ctrl+S</strong> 提示词库覆盖保存</span>
                      <span><strong style="color: #6ee7b7;">Ctrl+/</strong> 注释当前行</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
                      <span><strong style="color: #6ee7b7;">TAB</strong> 隐藏/显示右面板</span>
                    </div>
                    <div style="padding: 4px 0; margin-top: 8px; color: rgba(255,255,255,0.5); font-size: 11px;">
                      <span>提示词高亮：<span style="color: #2d8a4e;">深绿色</span>=注释，<span style="color: #c9444d;">深红色</span>=有权重</span>
                    </div>
                  </div>
                </div>

                <div class="settings-links">
                  <a href="https://github.com/ikusag-png/ComfyUI_bsk_UI/" target="_blank" class="settings-link" title="GitHub">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                  </a>
                  <a href="https://space.bilibili.com/26779709" target="_blank" class="settings-link" title="Bilibili">
                    <svg class="link-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z"/></svg>
                  </a>
                </div>
              </div>
            </div>

            <!-- 图库面板 -->
            <div class="gallery-panel" id="gallery-panel">
              <div class="gallery-header">
                <span>Z/X切换</span>
                <div class="gallery-header-buttons">
                  <button class="panel-btn panel-btn-secondary panel-btn-small" id="clear-input-btn">清空输入</button>
                  <button class="panel-btn panel-btn-secondary panel-btn-small" id="clear-output-btn">清空输出</button>
                  <button class="panel-btn panel-btn-secondary panel-btn-small" id="refresh-gallery-btn">刷新</button>
                </div>
              </div>
              <div class="gallery-files" id="gallery-files"></div>
            </div>

            <!-- 主题编辑器面板 -->
            <div class="theme-panel" id="theme-panel">
              <div class="theme-header">🎨 配色主题编辑</div>
              <div class="theme-content" id="theme-editor-content">
                <!-- 动态生成 -->
              </div>
              <div style="padding: 16px; border-top: 1px solid rgba(255,255,255,0.1);">
                <button class="panel-btn panel-btn-primary" id="apply-theme-btn" style="width: 100%;">应用主题</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      this.elements = {
        statusDot: document.getElementById('status-dot'),
        workflowFile: document.getElementById('workflow-file'),
        uploadWorkflowBtn: document.getElementById('upload-workflow-btn'),
        rebootBtn: document.getElementById('reboot-btn'),
        loadConfigBtn: document.getElementById('load-config-btn'),
        saveConfigBtn: document.getElementById('save-config-btn'),
        saveAsBtn: document.getElementById('save-as-btn'),
        generateBtn: document.getElementById('generate-btn'),
        interruptBtn: document.getElementById('interrupt-btn'),
        clearQueueBtn: document.getElementById('clear-queue-btn'),
        queueInfo: document.getElementById('queue-info'),
        queueCount: document.getElementById('queue-count'),
        closeBtn: document.getElementById('close-btn'),
        previewPanel: document.getElementById('panel-preview'),
        contentBg: document.getElementById('panel-content-bg'),
        previewContentBg: document.getElementById('preview-content-bg'),
        panelConfig: document.getElementById('panel-config'),
        previewContainer: document.getElementById('preview-container'),
        previewPlaceholder: document.getElementById('preview-placeholder'),
        previewImage: document.getElementById('preview-image'),
        previewVideo: document.getElementById('preview-video'),
        previewVideoInfo: document.getElementById('preview-video-info'),
        videoFrameInfo: document.getElementById('video-frame-info'),
        previewZoomInfo: document.getElementById('preview-zoom-info'),
        previousResultThumb: document.getElementById('previous-result-thumb'),
        thumbImage: document.getElementById('thumb-image'),
        thumbDownloadIndicator: document.getElementById('thumb-download-indicator'),
        // 圆形进度指示器
        circularProgress: document.getElementById('circular-progress'),
        circularProgressText: document.getElementById('circular-progress-text'),
        // 加载图像卡片浮动面板
        imageCardFloatPanel: document.getElementById('image-card-float-panel'),
        floatPanelTitle: document.getElementById('float-panel-title'),
        floatPanelBody: document.getElementById('float-panel-body'),
        floatPanelPin: document.getElementById('float-panel-pin'),
        progressContainer: document.getElementById('progress-container'),
        progressFill: document.getElementById('progress-fill'),
        progressText: document.getElementById('progress-text'),
        resizer: document.getElementById('resizer'),
        downloadBtn: document.getElementById('download-btn'),  // 新增
        addCardBtn: document.getElementById('add-card-btn'),
        settingsMainBtn: document.getElementById('settings-main-btn'),
        collapseAllBtn: document.getElementById('collapse-all-btn'),
        expandAllBtn: document.getElementById('expand-all-btn'),
        seedPanelHeader: document.getElementById('seed-panel-header'),
        configContent: document.getElementById('config-content'),
        configCards: document.getElementById('config-cards'),
        emptyState: document.getElementById('empty-state'),
        settingsPanel: document.getElementById('settings-panel'),
        settingsNodes: document.getElementById('settings-nodes'),
        nodeSearch: document.getElementById('node-search'),
        seedPanel: document.getElementById('seed-panel'),
        seedEnabled: document.getElementById('seed-enabled'),
        seedNodeSelect: document.getElementById('seed-node-select'),
        seedValue: document.getElementById('seed-value'),
        seedRandomBtn: document.getElementById('seed-random-btn'),
        seedGenerated: document.getElementById('seed-generated'),
        galleryBtn: document.getElementById('gallery-btn'),
        galleryPanel: document.getElementById('gallery-panel'),
        galleryFiles: document.getElementById('gallery-files'),
        refreshGalleryBtn: document.getElementById('refresh-gallery-btn'),
        clearInputBtn: document.getElementById('clear-input-btn'),
        clearOutputBtn: document.getElementById('clear-output-btn'),
        // 提示词库相关
        promptLibraryBtn: document.getElementById('prompt-library-btn'),
        promptLibraryPanel: document.getElementById('prompt-library-panel'),
        promptCardSelect: document.getElementById('prompt-card-select'),
        promptRefreshBtn: document.getElementById('prompt-refresh-btn'),
        promptSaveBtn: document.getElementById('prompt-save-btn'),
        promptBackBtn: document.getElementById('prompt-back-btn'),
        promptOverwriteBtn: document.getElementById('prompt-overwrite-btn'),
        promptMaximizeBtn: document.getElementById('prompt-maximize-btn'),
        promptFontSize: document.getElementById('prompt-font-size'),
        fontSizeValue: document.getElementById('font-size-value'),
        highlightColorA: document.getElementById('highlight-color-a'),
        highlightColorB: document.getElementById('highlight-color-b'),
        editorBgColor: document.getElementById('editor-bg-color'),
        promptDarkModeBtn: document.getElementById('prompt-dark-mode-btn'),
        promptLibraryList: document.getElementById('prompt-library-list'),
        promptCardList: document.getElementById('prompt-card-list'),
        refreshCardListBtn: document.getElementById('refresh-card-list-btn'),
        promptPreviewTitle: document.getElementById('prompt-preview-title'),
        promptPreviewTextarea: document.getElementById('prompt-preview-textarea'),
        promptHighlightPre: document.getElementById('prompt-highlight-pre'),
        tabsContainer: document.getElementById('tabs-container'),
        newTabName: document.getElementById('new-tab-name'),
        addTabBtn: document.getElementById('add-tab-btn'),
        serverConfigSelect: document.getElementById('server-config-select'),
        mainSettingsPanel: document.getElementById('main-settings-panel'),
        themeBtn: document.getElementById('theme-btn'),
        themePanel: document.getElementById('theme-panel'),
        themeEditorContent: document.getElementById('theme-editor-content'),
        applyThemeBtn: document.getElementById('apply-theme-btn'),
      };
    }

    bindEvents() {
      this.elements.closeBtn.onclick = () => this.hide();

      this.elements.uploadWorkflowBtn.onclick = () => this.elements.workflowFile.click();
      this.elements.workflowFile.onchange = (e) => this.loadUploadedWorkflow(e);
      this.elements.rebootBtn.onclick = () => this.rebootComfyUI();

      this.elements.generateBtn.onclick = () => this.execute();
      this.elements.interruptBtn.onclick = () => this.interrupt();
      this.elements.clearQueueBtn.onclick = () => this.clearQueue();

      this.elements.downloadBtn.onclick = () => this.downloadCurrentImage();
      this.elements.addCardBtn.onclick = () => this.toggleSettings();
      this.elements.settingsMainBtn.onclick = () => this.toggleMainSettings();
      this.elements.collapseAllBtn.onclick = () => this.collapseAllCards();
      this.elements.expandAllBtn.onclick = () => this.expandAllCards();

      // 随机种子面板折叠
      this.elements.seedPanelHeader.onclick = (e) => {
        // 如果点击的是启用复选框，不触发折叠
        if (e.target.id === 'seed-enabled' || e.target.closest('label')) return;
        this.elements.seedPanel.classList.toggle('collapsed');
      };

      this.elements.saveConfigBtn.onclick = () => this.saveConfig();
      this.elements.saveAsBtn.onclick = () => this.saveConfigAs();
      this.elements.loadConfigBtn.onclick = () => this.loadConfigDialog();

      this.elements.nodeSearch.oninput = (e) => this.filterNodes(e.target.value);

      this.elements.seedEnabled.onchange = (e) => { this.seedEnabled = e.target.checked; };
      this.elements.seedNodeSelect.onchange = (e) => { this.seedNode = e.target.value || null; };
      this.elements.seedValue.oninput = (e) => {
        this.seedValue = e.target.value;
        this.updateSeedDisplay();
      };

      this.elements.seedRandomBtn.onclick = async () => {
        this.seedValue = await generateRandomSeed();
        this.elements.seedValue.value = this.seedValue;
        this.updateSeedDisplay();
      };

      this.elements.galleryBtn.onclick = () => this.toggleGallery();
      this.elements.refreshGalleryBtn.onclick = () => this.loadGalleryFiles();
      this.elements.clearInputBtn.onclick = () => this.clearInputFiles();
      this.elements.clearOutputBtn.onclick = () => this.clearOutputFiles();

      // 提示词库按钮事件
      this.elements.promptLibraryBtn.onclick = () => this.togglePromptLibrary();
      this.elements.promptRefreshBtn.onclick = () => this.refreshPromptCardSelect();
      this.elements.promptSaveBtn.onclick = () => this.savePromptToLibrary();
      this.elements.promptBackBtn.onclick = () => this.togglePromptLibrary(); // 返回按钮
      this.elements.promptOverwriteBtn.onclick = () => this.overwriteCurrentPrompt(); // 覆盖保存按钮
      this.elements.promptMaximizeBtn.onclick = () => this.togglePromptLibraryMaximize(); // 最大化/还原按钮
      // 刷新卡片列表按钮
      this.elements.refreshCardListBtn.onclick = () => this.renderPromptCardList();
      // 字体大小滑竿
      this.elements.promptFontSize.oninput = () => this.changePreviewFontSize();
      // 高亮颜色选择器
      this.elements.highlightColorA.oninput = () => this.updateHighlightColors();
      this.elements.highlightColorB.oninput = () => this.updateHighlightColors();
      // 编辑框背景色选择器
      this.elements.editorBgColor.oninput = () => this.updateEditorBgColor();
      // 深色模式切换
      this.elements.promptDarkModeBtn.onclick = () => this.togglePromptLibraryDarkMode();
      // 预览文本编辑事件
      this.elements.promptPreviewTextarea.addEventListener('input', () => this.onPreviewTextareaChange());
      // 快捷键注释支持
      this.elements.promptPreviewTextarea.addEventListener('keydown', (e) => this.handlePreviewKeydown(e));
      // 提示词库编辑框滚动同步
      this.elements.promptPreviewTextarea.addEventListener('scroll', () => {
        if (this.elements.promptHighlightPre) {
          this.elements.promptHighlightPre.scrollTop = this.elements.promptPreviewTextarea.scrollTop;
          this.elements.promptHighlightPre.scrollLeft = this.elements.promptPreviewTextarea.scrollLeft;
        }
      });
      // 提示词库编辑框双击注释功能
      this.elements.promptPreviewTextarea.addEventListener('dblclick', (e) => {
        if (!e.ctrlKey) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const result = this.toggleCommentAtPosition(this.elements.promptPreviewTextarea, e);
        if (result.modified) {
          // 设置光标位置
          this.elements.promptPreviewTextarea.setSelectionRange(result.cursorOffset, result.cursorOffset);
          // 更新高亮显示
          if (this.elements.promptHighlightPre) {
            this.renderTextareaHighlight(this.elements.promptHighlightPre, this.elements.promptPreviewTextarea.value);
          }
          // 触发保存状态更新
          this.onPreviewTextareaChange();
        }
      });

      // 浮动缩略图点击下载
      this.elements.previousResultThumb.onclick = (e) => {
        // 只有在未展开状态下才触发下载
        if (!this.elements.previousResultThumb.classList.contains('expanded')) {
          this.downloadPreviousResult();
        }
      };

      // 浮动缩略图悬停放大效果
      // 缩略图缩放和平移状态
      this.thumbZoom = 1;
      this.thumbPanX = 0;
      this.thumbPanY = 0;
      this.isDraggingThumb = false;
      this.thumbDragStartX = 0;
      this.thumbDragStartY = 0;
      this.thumbDragStartPanX = 0;
      this.thumbDragStartPanY = 0;
      
      // 使用一个变量来跟踪是否应该保持展开
      this.thumbShouldStayExpanded = false;
      this.thumbHoverTimeout = null;
      this.thumbCollapseTimeout = null;

      // 鼠标移入展开
      this.elements.previousResultThumb.addEventListener('mouseenter', () => {
        // 清除收起定时器
        if (this.thumbCollapseTimeout) {
          clearTimeout(this.thumbCollapseTimeout);
          this.thumbCollapseTimeout = null;
        }
        
        // 延迟展开
        this.thumbHoverTimeout = setTimeout(() => {
          this.elements.previousResultThumb.classList.add('expanded');
          // 重置缩放和平移，让图片居中显示
          this.thumbZoom = 1;
          this.centerThumbImage();
        }, 150);
      });

      // 鼠标移出收起
      this.elements.previousResultThumb.addEventListener('mouseleave', () => {
        // 清除展开定时器
        if (this.thumbHoverTimeout) {
          clearTimeout(this.thumbHoverTimeout);
          this.thumbHoverTimeout = null;
        }
        
        // 延迟收起，给用户时间移动回来
        this.thumbCollapseTimeout = setTimeout(() => {
          this.elements.previousResultThumb.classList.remove('expanded');
          // 重置缩放和平移
          this.thumbZoom = 1;
          this.thumbPanX = 0;
          this.thumbPanY = 0;
        }, 300);
      });

      // 为展开的缩略图添加缩放和拖拽功能
      this.bindThumbZoomEvents();

      this.elements.addTabBtn.onclick = () => this.addTabFromInput();

      this.elements.serverConfigSelect.onmousedown = () => {
        if (this.elements.serverConfigSelect.options.length <= 1) {
          this.loadServerConfigList();
        }
      };
      this.elements.serverConfigSelect.onchange = () => {
        this.loadServerConfig();
      };

      this.elements.themeBtn.onclick = () => this.toggleThemePanel();
      this.elements.applyThemeBtn.onclick = () => this.applyThemeFromInputs();

      this.bindResizer();
      this.bindWebSocketEvents();
      this.bindPreviewZoomEvents();
      this.bindDragScroll();

      this.loadServerConfigList();
      this.startQueueCheck();
      
      // 独立模式：连接按钮事件（只在显式独立模式下绑定）
      const isExplicitStandalone = window.COMFYUI_PANEL_STANDALONE === true;
      if (isExplicitStandalone) {
        const connectBtn = document.getElementById('connect-btn');
        const urlInput = document.getElementById('server-url-input');
        
        if (connectBtn && urlInput) {
          connectBtn.onclick = () => {
            const url = urlInput.value.trim();
            if (url) {
              this.connectToServer(url);
            } else {
              this.showToast('请输入服务器地址');
            }
          };
          
          // 回车键触发连接
          urlInput.onkeypress = (e) => {
            if (e.key === 'Enter') {
              const url = urlInput.value.trim();
              if (url) {
                this.connectToServer(url);
              }
            }
          };
        }
      }
    }

    toggleMainSettings() {
      // 如果当前活动面板是这个按钮，则返回卡片界面
      if (this.activePanelBtn === 'settingsMainBtn') {
        this.returnToCards();
        return;
      }
      
      // 打开设置面板
      this.setActivePanel('settingsMainBtn');
      this.hideAllPanels();
      this.elements.mainSettingsPanel.classList.add('visible');
      this.elements.configContent.style.display = 'none';
    }

    hideAllPanels() {
      this.elements.galleryPanel.classList.remove('visible');
      this.elements.settingsPanel.classList.remove('visible');
      this.elements.themePanel.classList.remove('visible');
      this.elements.mainSettingsPanel.classList.remove('visible');
      // 提示词库面板是浮动面板，不在这里隐藏
    }
    
    setActivePanel(btnId) {
      // 清除之前的活动状态
      if (this.activePanelBtn) {
        const prevBtn = this.elements[this.activePanelBtn];
        if (prevBtn) {
          prevBtn.classList.remove('active-panel');
          // 恢复原图标
          this.restoreButtonIcon(this.activePanelBtn);
        }
      }

      // 设置新的活动状态
      this.activePanelBtn = btnId;
      const btn = this.elements[btnId];
      if (btn) {
        btn.classList.add('active-panel');
        // 返回图标（使用SVG）
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 10 4 15 9 20"></polyline>
          <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
        </svg>`;
      }
      
      // 只有当按钮在左侧按钮组内时，才让按钮组保持展开状态
      // settingsMainBtn 在右侧工具栏，不应该触发左侧按钮组展开
      const leftBtnGroupBtns = ['addCardBtn', 'galleryBtn'];
      const btnGroup = document.getElementById('left-btn-group');
      if (btnGroup && leftBtnGroupBtns.includes(btnId)) {
        btnGroup.classList.add('expanded');
      }
    }
    
    returnToCards() {
      // 清除活动状态
      if (this.activePanelBtn) {
        const btn = this.elements[this.activePanelBtn];
        if (btn) {
          btn.classList.remove('active-panel');
          this.restoreButtonIcon(this.activePanelBtn);
        }
      }
      this.activePanelBtn = null;

      // 隐藏所有面板，显示卡片
      this.hideAllPanels();
      // 同时隐藏提示词库浮动面板
      this.elements.promptLibraryPanel.classList.remove('visible');
      this.elements.configContent.style.display = 'block';
      
      // 移除按钮组的展开状态，恢复自动折叠
      const btnGroup = document.getElementById('left-btn-group');
      if (btnGroup) {
        btnGroup.classList.remove('expanded');
      }
    }
    
    restoreButtonIcon(btnId) {
      const iconMap = {
        'addCardBtn': '➕',
        'settingsMainBtn': '⚙',
        'galleryBtn': '🖼',
        'promptLibraryBtn': `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          <line x1="8" y1="7" x2="16" y2="7"></line>
          <line x1="8" y1="11" x2="14" y2="11"></line>
        </svg>`
      };
      const btn = this.elements[btnId];
      if (btn && iconMap[btnId]) {
        if (btnId === 'promptLibraryBtn') {
          btn.innerHTML = iconMap[btnId];
        } else {
          btn.textContent = iconMap[btnId];
        }
      }
    }

    toggleThemePanel() {
      const isVisible = this.elements.themePanel.classList.contains('visible');
      if (isVisible) {
        this.elements.themePanel.classList.remove('visible');
        this.elements.mainSettingsPanel.classList.add('visible');
      } else {
        this.hideAllPanels();
        this.elements.themePanel.classList.add('visible');
        this.generateThemeEditor();
      }
    }

    generateThemeEditor() {
      const container = this.elements.themeEditorContent;
      container.innerHTML = '';

      const themeLabels = {
        'primaryGradient': '主渐变色',
        'backgroundColor': '背景渐变',
        'cardBackground': '卡片背景',
        'borderStyle': '边框颜色',
        'accentColor': '强调色',
        'textColor': '文字颜色',
        'placeholderColor': '占位符颜色'
      };

      for (const [key, value] of Object.entries(this.theme)) {
        const item = document.createElement('div');
        item.className = 'theme-item';
        
        const label = document.createElement('label');
        label.textContent = themeLabels[key] || key;
        
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.dataset.themeKey = key;
        
        // 尝试从值中提取颜色
        let colorValue = '#ffffff';
        if (typeof value === 'string') {
          if (value.startsWith('#')) {
            colorValue = value;
          } else if (value.startsWith('rgba')) {
            const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
              const r = parseInt(match[1]);
              const g = parseInt(match[2]);
              const b = parseInt(match[3]);
              colorValue = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
            }
          }
        }
        colorInput.value = colorValue;
        
        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.value = value;
        textInput.dataset.themeKey = key;
        
        colorInput.addEventListener('input', (e) => {
          textInput.value = e.target.value;
        });
        
        textInput.addEventListener('input', (e) => {
          const val = e.target.value;
          if (val.startsWith('#') && val.length === 7) {
            colorInput.value = val;
          }
        });
        
        item.appendChild(label);
        item.appendChild(colorInput);
        item.appendChild(textInput);
        container.appendChild(item);
      }
    }

    applyThemeFromInputs() {
      const items = this.elements.themeEditorContent.querySelectorAll('.theme-item');
      items.forEach(item => {
        const textInput = item.querySelector('input[type="text"]');
        const key = textInput.dataset.themeKey;
        this.theme[key] = textInput.value;
      });
      this.updateThemeStyles();
      this.showToast('主题已更新');
    }

    addTab(name, id = null) {
      if (!id) id = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      
      const tab = {
        id: id,
        name: name,
        nodeIds: []
      };
      
      this.tabs.push(tab);
      this.tabNodes[id] = [];
      this.renderTabs();
      
      if (this.tabs.length === 1) {
        this.switchTab(id);
      }
      
      this.updateTargetTabSelect();
    }

    renderTabs() {
      const container = this.elements.tabsContainer;
      container.innerHTML = '';
      
      this.tabs.forEach(tab => {
        const tabEl = document.createElement('div');
        tabEl.className = `tab ${tab.id === this.currentTab?.id ? 'active' : ''}`;
        tabEl.innerHTML = `
          <span>${tab.name}</span>
          <span class="tab-close" data-tab-id="${tab.id}">✕</span>
        `;
        
        tabEl.onclick = (e) => {
          if (e.target.classList.contains('tab-close')) {
            this.removeTab(tab.id);
          } else {
            this.switchTab(tab.id);
          }
        };
        
        container.appendChild(tabEl);
      });
    }

    switchTab(tabId) {
      const tab = this.tabs.find(t => t.id === tabId);
      if (!tab) return;
      
      // 如果当前有活动面板（图库、设置、添加卡片），点击标签时返回卡片界面
      if (this.activePanelBtn) {
        this.returnToCards();
      }
      
      this.currentTab = tab;
      // 确保 activeCards 和 tab.nodeIds 是同一个引用
      this.activeCards = tab.nodeIds;
      this.tabNodes[tab.id] = tab.nodeIds;
      this.renderTabs();
      this.renderConfigCards();
      this.renderSettingsNodes();
    }

    removeTab(tabId) {
      if (this.tabs.length <= 1) {
        alert('至少需要保留一个标签');
        return;
      }
      
      const tabIndex = this.tabs.findIndex(t => t.id === tabId);
      if (tabIndex === -1) return;
      
      if (this.currentTab?.id === tabId) {
        const otherTab = this.tabs.find(t => t.id !== tabId);
        if (otherTab) {
          this.switchTab(otherTab.id);
        }
      }
      
      this.tabs.splice(tabIndex, 1);
      delete this.tabNodes[tabId];
      this.renderTabs();
    }

    updateTargetTabSelect() {
      // 不再需要，已移除目标标签选择
    }

    addTabFromInput() {
      const name = this.elements.newTabName.value.trim();
      if (!name) {
        alert('请输入标签名称');
        return;
      }
      
      this.addTab(name);
      this.elements.newTabName.value = '';
    }

    updateSeedDisplay() {
      const el = this.elements.seedGenerated;
      if (this.seedValue === "-1" || this.seedValue === -1) {
        if (this.lastGeneratedSeed !== null) {
          el.textContent = `生成值: ${this.lastGeneratedSeed}`;
          el.style.display = 'block';
        } else {
          el.style.display = 'none';
        }
      } else {
        el.style.display = 'none';
      }
    }

    bindKeyboard() {
      this.lastMouseX = 0;
      this.lastMouseY = 0;
      document.addEventListener('mousemove', (e) => {
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      });

      document.addEventListener('keydown', (e) => {
        if (!this.panelVisible) return;

        const tagName = e.target.tagName.toLowerCase();
        const isInput = tagName === 'input' || tagName === 'textarea' || tagName === 'select' || e.target.isContentEditable;

        // Ctrl+Enter 在文本编辑时触发生成
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          this.elements.generateBtn.click();
          return false;
        }

        // 如果正在输入文本，忽略快捷键（ESC除外，因为用户可能想退出输入模式或关闭面板）
        // 如果希望输入时按ESC也能关闭面板，可以将 isInput 判断移到具体按键逻辑中
        // 这里建议：如果正在输入，ESC不关闭面板（浏览器默认行为或退出编辑），其他快捷键无效
        if (isInput && e.key !== 'Escape') return; 

        // --- ESC 关闭逻辑 ---
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          
          // 如果提示词库面板打开，先关闭提示词库面板
          if (this.elements.promptLibraryPanel.classList.contains('visible')) {
            this.togglePromptLibrary();
            return false;
          }
          
          // 否则关闭主面板
          this.hide();
          return false;
        }
        // -------------------------

        // --- Tab 切换右侧面板 ---
        if (e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          this.toggleRightPanel();
          return false;
        }
        // -------------------------


        if (this.elements.galleryPanel.classList.contains('visible')) {
          if (e.key === 'z' || e.key === 'Z') {
            e.preventDefault();
            this.selectPrevGalleryFile();
            return;
          }
          if (e.key === 'x' || e.key === 'X') {
            e.preventDefault();
            this.selectNextGalleryFile();
            return;
          }
        }

        if (e.key === 'g' || e.key === 'G') {
          if (e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          // 允许多次执行，任务会加入队列
          this.elements.generateBtn.click();
          return false;
        }

        if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          e.stopPropagation();
          this.downloadCurrentImage();
          return false;
        }

        if (e.key === 'c' || e.key === 'C') {
          // 如果按下 Ctrl 或 Cmd 键，不处理（让浏览器处理默认的复制操作）
          if (e.ctrlKey || e.metaKey) return;
          e.preventDefault();
          e.stopPropagation();
          this.copyCurrentImage();
          return false;
        }

        if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          e.stopPropagation();
          this.pasteImageAtMouse();
          return false;
        }

        // B键切换提示词库
        if (e.key === 'b' || e.key === 'B') {
          e.preventDefault();
          e.stopPropagation();
          this.togglePromptLibrary();
          return false;
        }
      }, true);
    }

    // 提示词库功能
    togglePromptLibrary() {
      const panel = this.elements.promptLibraryPanel;
      const isVisible = panel.classList.contains('visible');

      if (isVisible) {
        // 如果有未保存的编辑，先自动保存
        if (this.previewUnsaved) {
          // 如果是卡片编辑模式，保存卡片内容
          if (this.currentHoveredCardKey) {
            const newContent = this.elements.promptPreviewTextarea.value;
            if (newContent) {
              this.cardValues[this.currentHoveredCardKey] = newContent;
              // 静默保存面板配置（不下载、不弹提示）
              this.saveConfigSilent();
              console.log('[ComfyUI Panel] Auto saved card:', this.currentHoveredCardKey);
            }
          } 
          // 如果是提示词库编辑模式，保存提示词库
          else if (this.currentPreviewIndex >= 0 && this.currentPreviewPrompt) {
            this.autoSavePromptLibrary();
          }
          this.previewUnsaved = false;
        }
        
        // 隐藏面板
        panel.classList.remove('visible');
        panel.classList.remove('docked'); // 移除停靠模式
        // 恢复按钮图标
        this.elements.promptLibraryBtn.classList.remove('active-panel');
        this.restoreButtonIcon('promptLibraryBtn');
        // 注意：不清除 currentHoveredCardKey 和 currentPreviewPrompt/currentPreviewIndex
        // 这样再次显示时可以恢复上次的选中状态
        // 重置最大化状态
        this.promptLibraryMaximized = true;
        this.updateMaximizeButton();
        
        // 移除按钮组的展开状态，恢复自动折叠
        const btnGroup = document.getElementById('left-btn-group');
        if (btnGroup) {
          btnGroup.classList.remove('expanded');
        }
      } else {
        // 显示面板（默认最大化模式）
        // 先移动到正确位置（comfyui-panel-main 下，panel-content 之前）
        const mainPanel = document.getElementById('comfyui-panel-main');
        const panelContent = document.querySelector('.panel-content');
        if (mainPanel && panelContent) {
          panelContent.before(panel);
        }
        
        panel.classList.add('visible');
        panel.classList.remove('docked'); // 默认最大化
        // 设置按钮为返回图标
        this.elements.promptLibraryBtn.classList.add('active-panel');
        this.elements.promptLibraryBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 10 4 15 9 20"></polyline>
          <path d="M20 4v7a4 4 0 0 1-4 4H4"></path>
        </svg>`;
        // 自动刷新卡片列表
        this.renderPromptCardList();
        this.refreshPromptCardSelect();
        this.loadPromptLibrary();
        // 设置为最大化模式
        this.promptLibraryMaximized = true;
        this.updateMaximizeButton();
        
        // 应用提示词库主题
        this.applyPromptLibraryTheme();
        // 更新颜色选择器显示
        if (this.elements.highlightColorA) {
          this.elements.highlightColorA.value = this.highlightColorA;
        }
        if (this.elements.highlightColorB) {
          this.elements.highlightColorB.value = this.highlightColorB;
        }
        // 更新编辑框背景色选择器（根据当前模式显示对应颜色）
        this.updateEditorBgColorPicker();
        
        // 恢复上次的选中状态
        this.restorePromptLibrarySelection();
        
        // 让按钮组保持展开状态，方便点击返回
        const btnGroup = document.getElementById('left-btn-group');
        if (btnGroup) {
          btnGroup.classList.add('expanded');
        }
      }
    }

    // 自动保存提示词库编辑（切换或返回时调用）
    async autoSavePromptLibrary() {
      if (this.currentPreviewIndex < 0 || !this.currentPreviewPrompt) return;
      
      const newContent = this.elements.promptPreviewTextarea.value;
      if (!newContent) return;
      
      const firstLine = newContent.split('\n')[0].trim() || '无标题';
      this.promptLibrary[this.currentPreviewIndex].title = firstLine;
      this.promptLibrary[this.currentPreviewIndex].content = newContent;

      // 清除未保存状态
      this.previewUnsaved = false;
      // 隐藏覆盖保存按钮
      this.elements.promptOverwriteBtn.style.display = 'none';

      await this.savePromptLibraryConfig();
      this.renderPromptLibraryList();
      this.showToast('已自动保存');
    }

    // 恢复提示词库的选中状态
    restorePromptLibrarySelection() {
      // 如果上次选中的是卡片列表中的项目
      if (this.currentHoveredCardKey) {
        // 高亮卡片列表中的对应项
        const cardItems = this.elements.promptCardList.querySelectorAll('.prompt-card-item');
        cardItems.forEach(item => {
          if (item.dataset.cardKey === this.currentHoveredCardKey) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
        // 清除提示词列表的选中状态
        this.elements.promptLibraryList.querySelectorAll('.prompt-item').forEach(el => el.classList.remove('active'));
        
        // 更新标题显示
        const textareaCards = this.getTextareaCards();
        const targetCard = textareaCards.find(c => c.fullKey === this.currentHoveredCardKey);
        if (targetCard) {
          const cardId = this.currentHoveredCardKey.split('.')[0];
          this.elements.promptPreviewTitle.innerHTML = `
            <span class="card-id">#${cardId}</span>
            <span class="card-name">${targetCard.title}</span>
            <span class="loaded-badge">✓ 卡片</span>
          `;
        }
      }
      // 如果上次选中的是提示词列表中的项目
      else if (this.currentPreviewPrompt && this.currentPreviewIndex >= 0) {
        // 高亮提示词列表中的对应项
        const promptItems = this.elements.promptLibraryList.querySelectorAll('.prompt-item');
        promptItems.forEach((item, index) => {
          if (index === this.currentPreviewIndex) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
        // 清除卡片列表的选中状态
        this.elements.promptCardList.querySelectorAll('.prompt-card-item').forEach(el => el.classList.remove('active'));
        
        // 更新标题显示
        const cardId = this.currentPreviewPrompt.id.split('.')[0];
        this.elements.promptPreviewTitle.innerHTML = `
          <span class="card-id">#${cardId}</span>
          <span class="card-name">${this.currentPreviewPrompt.title}</span>
          <span class="loaded-badge">✓ 提示词</span>
        `;
      }
    }

    // 提示词库最大化状态
    promptLibraryMaximized = true;
    
    // 提示词库深色模式（默认深色）
    promptLibraryDarkMode = true;
    
    // 高亮颜色
    highlightColorA = '#6496c8'; // 蓝色系
    highlightColorB = '#c89664'; // 橙色系
    
    // 编辑框背景色（深色/浅色模式分别配置）
    editorBgColorDark = '#2a2a2f';   // 深色模式默认灰黑色
    editorBgColorLight = '#ffffff';  // 浅色模式默认白色

    // 切换深色/浅色模式
    togglePromptLibraryDarkMode() {
      this.promptLibraryDarkMode = !this.promptLibraryDarkMode;
      // 切换模式后更新颜色选择器显示
      this.updateEditorBgColorPicker();
      this.applyPromptLibraryTheme();
    }

    // 更新编辑框背景色选择器显示当前模式的颜色
    updateEditorBgColorPicker() {
      if (this.elements.editorBgColor) {
        this.elements.editorBgColor.value = this.promptLibraryDarkMode 
          ? this.editorBgColorDark 
          : this.editorBgColorLight;
      }
    }

    // 应用提示词库主题
    applyPromptLibraryTheme() {
      const panel = this.elements.promptLibraryPanel;
      const previewContent = this.elements.promptPreviewTextarea?.parentElement;
      const highlightPre = this.elements.promptHighlightPre;
      const textarea = this.elements.promptPreviewTextarea;
      
      if (this.promptLibraryDarkMode) {
        panel.classList.remove('light-mode');
        panel.classList.add('dark-mode');
        this.elements.promptDarkModeBtn.textContent = '🌙';
      } else {
        panel.classList.remove('dark-mode');
        panel.classList.add('light-mode');
        this.elements.promptDarkModeBtn.textContent = '☀️';
      }
      
      // 根据当前模式应用对应的编辑框背景色
      const bgColor = this.promptLibraryDarkMode 
        ? (this.editorBgColorDark || '#2a2a2f')
        : (this.editorBgColorLight || '#ffffff');
      
      if (previewContent) {
        previewContent.style.background = bgColor;
      }
      if (highlightPre) {
        highlightPre.style.background = bgColor;
      }
      if (textarea) {
        textarea.style.background = bgColor;
      }
    }

    // 更新高亮颜色
    updateHighlightColors() {
      this.highlightColorA = this.elements.highlightColorA.value;
      this.highlightColorB = this.elements.highlightColorB.value;
      // 重新渲染高亮
      if (this.elements.promptHighlightPre) {
        this.renderTextareaHighlight(this.elements.promptHighlightPre, this.elements.promptPreviewTextarea.value);
      }
      // 自动保存配置
      this.saveToLocalStorage();
    }

    // 更新编辑框背景色
    updateEditorBgColor() {
      // 根据当前模式更新对应的背景色变量
      if (this.promptLibraryDarkMode) {
        this.editorBgColorDark = this.elements.editorBgColor.value;
      } else {
        this.editorBgColorLight = this.elements.editorBgColor.value;
      }
      // 应用背景色
      this.applyPromptLibraryTheme();
      // 自动保存配置
      this.saveToLocalStorage();
    }

    // 切换最大化/还原
    togglePromptLibraryMaximize() {
      const panel = this.elements.promptLibraryPanel;
      this.promptLibraryMaximized = !this.promptLibraryMaximized;

      if (this.promptLibraryMaximized) {
        // 最大化模式：移动到 comfyui-panel-main 下，panel-content 之前
        const mainPanel = document.getElementById('comfyui-panel-main');
        const panelContent = document.querySelector('.panel-content');
        if (mainPanel && panelContent) {
          panelContent.before(panel);
        }
        panel.classList.remove('docked');
      } else {
        // 还原模式：移动到 preview-content 里面
        const previewContent = document.querySelector('.preview-content');
        if (previewContent) {
          previewContent.appendChild(panel);
        }
        panel.classList.add('docked');
      }

      this.updateMaximizeButton();
    }

    // 更新最大化按钮图标
    updateMaximizeButton() {
      const btn = this.elements.promptMaximizeBtn;
      if (!btn) return;
      
      const maximizeIcon = btn.querySelector('.maximize-icon');
      const restoreIcon = btn.querySelector('.restore-icon');

      if (this.promptLibraryMaximized) {
        // 当前是最大化，显示还原图标
        if (maximizeIcon) maximizeIcon.style.display = 'none';
        if (restoreIcon) restoreIcon.style.display = 'block';
        btn.title = '还原（停靠到左侧）';
      } else {
        // 当前是还原，显示最大化图标
        if (maximizeIcon) maximizeIcon.style.display = 'block';
        if (restoreIcon) restoreIcon.style.display = 'none';
        btn.title = '最大化';
      }
    }

    // 渲染卡片列表（右侧上方）
    renderPromptCardList() {
      const container = this.elements.promptCardList;
      container.innerHTML = '';

      const textareaCards = this.getTextareaCards();

      if (textareaCards.length === 0) {
        container.innerHTML = '<div class="empty-state" style="padding: 10px; font-size: 11px; color: rgba(0,0,0,0.4);">无多行文本卡片</div>';
        return;
      }

      textareaCards.forEach((card) => {
        const item = document.createElement('div');
        item.className = 'prompt-card-item';
        item.dataset.cardKey = card.fullKey;
        item.innerHTML = `
          <span class="card-node-id">#${card.id}</span>
          <span class="card-node-title" title="${card.title}">${card.title}</span>
        `;

        // 鼠标悬停时加载卡片内容到编辑框
        item.addEventListener('mouseenter', () => {
          this.loadCardToPromptEditor(card.fullKey, card.title);
          // 移除其他项的active状态
          container.querySelectorAll('.prompt-card-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
        });

        container.appendChild(item);
      });
    }

    // 当前悬停的卡片key
    currentHoveredCardKey = null;

    // 加载卡片内容到提示词编辑框
    loadCardToPromptEditor(cardFullKey, cardTitle) {
      // 如果有未保存的提示词编辑，先自动保存
      if (this.previewUnsaved && this.currentPreviewIndex >= 0 && this.currentPreviewPrompt) {
        this.autoSavePromptLibrary();
      }
      
      this.currentHoveredCardKey = cardFullKey;
      this.previewUnsaved = false;
      
      // 清除提示词列表的选中状态
      this.currentPreviewPrompt = null;
      this.currentPreviewIndex = -1;
      this.elements.promptLibraryList.querySelectorAll('.prompt-item').forEach(el => el.classList.remove('active'));

      // 获取卡片当前值
      const content = this.cardValues[cardFullKey] || '';

      // 更新预览文本
      this.elements.promptPreviewTextarea.value = content;
      // 更新高亮显示
      if (this.elements.promptHighlightPre) {
        this.renderTextareaHighlight(this.elements.promptHighlightPre, content);
      }

      // 更新标题
      const cardId = cardFullKey.split('.')[0];
      this.elements.promptPreviewTitle.innerHTML = `
        <span class="card-id">#${cardId}</span>
        <span class="card-name">${cardTitle}</span>
        <span class="loaded-badge">✓ 卡片</span>
      `;

      // 隐藏覆盖保存按钮
      this.elements.promptOverwriteBtn.style.display = 'none';
    }

    // 刷新多行文本卡片下拉列表 - 从所有标签页中获取（去重）
    refreshPromptCardSelect() {
      const select = this.elements.promptCardSelect;
      select.innerHTML = '<option value="">选择卡片...</option>';

      // 使用getTextareaCards获取所有标签页中的卡片
      const textareaCards = this.getTextareaCards();

      for (const card of textareaCards) {
        const option = document.createElement('option');
        option.value = card.fullKey;
        option.textContent = `#${card.id} ${card.title}`;
        select.appendChild(option);
      }
    }

    // 获取所有标签页中的多行文本卡片（去重）
    getTextareaCards() {
      const cards = [];
      const seenKeys = new Set();
      const nodeMap = new Map(this.parsedNodes.map(n => [n.id, n]));

      // 收集所有标签页中的节点ID（去重）
      const allNodeIds = new Set();
      this.tabs.forEach(tab => {
        if (tab.nodeIds) {
          tab.nodeIds.forEach(id => allNodeIds.add(id));
        }
      });

      // 遍历所有标签页中的卡片
      for (const nodeId of allNodeIds) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;

        for (const input of node.inputs) {
          if (input.widgetType === 'textarea') {
            const fullKey = `${node.id}.${input.key}`;
            // 去重：避免同一个卡片出现多次
            if (!seenKeys.has(fullKey)) {
              seenKeys.add(fullKey);
              cards.push({
                id: node.id,
                key: input.key,
                title: node.title,
                label: input.label,
                fullKey: fullKey
              });
            }
          }
        }
      }
      return cards;
    }

    // 保存提示词到库 - 总是新建项目
    async savePromptToLibrary() {
      const select = this.elements.promptCardSelect;
      const selectedValue = select.value;
      if (!selectedValue) {
        this.showToast('请先选择一个卡片');
        return;
      }

      // 优先使用预览框编辑后的内容
      let content;
      if (this.previewUnsaved && this.elements.promptPreviewTextarea.value) {
        content = this.elements.promptPreviewTextarea.value;
      } else {
        content = this.cardValues[selectedValue] || '';
      }

      if (!content || typeof content !== 'string') {
        this.showToast('内容为空');
        return;
      }

      // 获取第一行作为标题
      const firstLine = content.split('\n')[0].trim() || '无标题';

      // 总是添加新提示词（不覆盖）
      this.promptLibrary.push({
        id: selectedValue,
        title: firstLine,
        content: content
      });

      // 清除未保存状态
      this.previewUnsaved = false;
      // 隐藏覆盖保存按钮
      this.elements.promptOverwriteBtn.style.display = 'none';

      // 保存配置文件
      await this.savePromptLibraryConfig();
      // 刷新列表
      this.renderPromptLibraryList();
      this.showToast('已保存为新项');
    }

    // 渲染提示词库列表
    renderPromptLibraryList() {
      const container = this.elements.promptLibraryList;
      container.innerHTML = '';

      if (this.promptLibrary.length === 0) {
        container.innerHTML = '<div class="empty-state">暂无保存的提示词</div>';
        return;
      }

      this.promptLibrary.forEach((prompt, index) => {
        const item = document.createElement('div');
        item.className = 'prompt-item';
        item.dataset.index = index;
        item.innerHTML = `
          <span class="prompt-item-id">#${prompt.id.split('.')[0]}</span>
          <span class="prompt-item-title" title="${prompt.title}">${prompt.title}</span>
          <div class="prompt-item-actions">
            <button class="panel-btn panel-btn-icon" title="加载到卡片" data-action="load" data-index="${index}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
            </button>
            <button class="panel-btn panel-btn-icon" title="复制内容" data-action="copy" data-index="${index}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <button class="panel-btn panel-btn-icon" title="替换列表项" data-action="replace" data-index="${index}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            </button>
            <button class="panel-btn panel-btn-icon btn-danger" title="删除" data-action="delete" data-index="${index}">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>
        `;

        // 鼠标悬停预览 - 自动保存之前编辑的内容
        item.addEventListener('mouseenter', () => {
          // 如果有未保存的提示词编辑，先自动保存
          if (this.previewUnsaved && this.currentPreviewIndex >= 0 && this.currentPreviewPrompt) {
            this.autoSavePromptLibrary();
          }
          
          // 清除卡片列表的选中状态（这样编辑就不会同步到卡片）
          this.currentHoveredCardKey = null;
          this.elements.promptCardList.querySelectorAll('.prompt-card-item').forEach(el => el.classList.remove('active'));
          
          this.previewPrompt(prompt, index);
          // 移除其他项的active状态
          container.querySelectorAll('.prompt-item').forEach(el => el.classList.remove('active'));
          item.classList.add('active');
        });

        // 绑定按钮事件
        item.querySelectorAll('button').forEach(btn => {
          btn.onclick = (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const idx = parseInt(btn.dataset.index);
            this.handlePromptItemAction(action, idx);
          };
        });

        container.appendChild(item);
      });
    }

    // 当前预览的提示词索引
    currentPreviewIndex = -1;
    // 未保存状态
    previewUnsaved = false;

    // 预览提示词
    previewPrompt(prompt, index) {
      this.currentPreviewPrompt = prompt;
      this.currentPreviewIndex = index;
      this.previewUnsaved = false;
      
      // 清除卡片列表的选中状态（确保编辑不会同步到卡片）
      this.currentHoveredCardKey = null;

      // 更新预览文本
      this.elements.promptPreviewTextarea.value = prompt.content;
      // 更新高亮显示
      if (this.elements.promptHighlightPre) {
        this.renderTextareaHighlight(this.elements.promptHighlightPre, prompt.content);
      }

      // 更新标题 - 显示提示词模式
      const cardId = prompt.id.split('.')[0];
      const textareaCards = this.getTextareaCards();
      const targetCard = textareaCards.find(c => c.fullKey === prompt.id);
      const cardName = targetCard ? targetCard.title : '提示词库';

      this.elements.promptPreviewTitle.innerHTML = `
        <span class="card-id">#${cardId}</span>
        <span class="card-name">${cardName}</span>
        <span class="loaded-badge" style="color: #667eea;">📝 提示词</span>
      `;

      // 隐藏覆盖保存按钮
      this.elements.promptOverwriteBtn.style.display = 'none';
    }

    // 更新预览标题
    updatePreviewTitle(cardFullKey, extraInfo = '') {
      const titleEl = this.elements.promptPreviewTitle;
      const cardId = cardFullKey.split('.')[0];
      const textareaCards = this.getTextareaCards();
      const targetCard = textareaCards.find(c => c.fullKey === cardFullKey);

      let cardName = '';
      let noCardHint = '';

      if (targetCard) {
        cardName = targetCard.title;
      } else if (textareaCards.length > 0) {
        cardName = textareaCards[0].title + ' (第一个可用)';
      } else {
        noCardHint = '无多行文本卡片';
      }

      titleEl.innerHTML = `
        <span class="card-id">#${cardId}</span>
        <span class="card-name">${cardName}</span>
        ${extraInfo ? `<span class="${extraInfo.class}">${extraInfo.text}</span>` : ''}
        ${noCardHint ? `<span class="no-card-hint">${noCardHint}</span>` : ''}
      `;
    }

    // 改变预览字体大小
    changePreviewFontSize() {
      const size = this.elements.promptFontSize.value;
      this.elements.promptPreviewTextarea.style.fontSize = size + 'px';
      this.elements.fontSizeValue.textContent = size;
      // 同步更新高亮层字体大小
      if (this.elements.promptHighlightPre) {
        this.elements.promptHighlightPre.style.fontSize = size + 'px';
      }
    }

    // 预览文本编辑变化
    onPreviewTextareaChange() {
      // 更新高亮显示
      if (this.elements.promptHighlightPre) {
        this.renderTextareaHighlight(this.elements.promptHighlightPre, this.elements.promptPreviewTextarea.value);
      }
      
      // 如果当前有选中的卡片（通过鼠标悬停卡片列表），直接同步到卡片值
      if (this.currentHoveredCardKey) {
        const newContent = this.elements.promptPreviewTextarea.value;
        this.cardValues[this.currentHoveredCardKey] = newContent;
        
        // 标记为未保存（需要保存到配置文件）
        this.previewUnsaved = true;
        
        // 同步更新UI中的textarea（如果存在）
        const textarea = document.querySelector(`textarea[data-key="${this.currentHoveredCardKey}"]`);
        if (textarea && textarea !== this.elements.promptPreviewTextarea) {
          textarea.value = newContent;
          textarea.dispatchEvent(new Event('input'));
          
          // 更新卡片的高亮显示
          const container = textarea.closest('.textarea-highlight-container');
          if (container) {
            const highlightPre = container.querySelector('.textarea-highlight-pre');
            if (highlightPre) {
              this.renderTextareaHighlight(highlightPre, newContent);
            }
          }
        }
        
        // 更新标题显示已同步
        const cardId = this.currentHoveredCardKey.split('.')[0];
        const textareaCards = this.getTextareaCards();
        const targetCard = textareaCards.find(c => c.fullKey === this.currentHoveredCardKey);
        const cardName = targetCard ? targetCard.title : '';
        
        this.elements.promptPreviewTitle.innerHTML = `
          <span class="card-id">#${cardId}</span>
          <span class="card-name">${cardName}</span>
          <span class="loaded-badge" style="color: #22c55e;">✓ 已同步</span>
        `;
      } 
      // 如果当前是提示词模式，显示未保存状态
      else if (this.currentPreviewPrompt && this.currentPreviewIndex >= 0) {
        if (!this.previewUnsaved) {
          this.previewUnsaved = true;
          // 更新标题显示未保存状态
          const cardId = this.currentPreviewPrompt.id.split('.')[0];
          const textareaCards = this.getTextareaCards();
          const targetCard = textareaCards.find(c => c.fullKey === this.currentPreviewPrompt.id);
          const cardName = targetCard ? targetCard.title : '提示词库';
          
          this.elements.promptPreviewTitle.innerHTML = `
            <span class="card-id">#${cardId}</span>
            <span class="card-name">${cardName}</span>
            <span class="unsaved-badge">✎ 未保存</span>
          `;
          // 显示覆盖保存按钮
          this.elements.promptOverwriteBtn.style.display = 'flex';
        }
      }
    }

    // 覆盖当前选中的提示词
    async overwriteCurrentPrompt() {
      if (this.currentPreviewIndex < 0 || !this.currentPreviewPrompt) {
        this.showToast('请先选择一个提示词项');
        return;
      }

      const newContent = this.elements.promptPreviewTextarea.value;
      if (!newContent) {
        this.showToast('内容为空');
        return;
      }

      const firstLine = newContent.split('\n')[0].trim() || '无标题';
      this.promptLibrary[this.currentPreviewIndex].title = firstLine;
      this.promptLibrary[this.currentPreviewIndex].content = newContent;

      // 清除未保存状态
      this.previewUnsaved = false;
      // 隐藏覆盖保存按钮
      this.elements.promptOverwriteBtn.style.display = 'none';

      await this.savePromptLibraryConfig();
      this.renderPromptLibraryList();
      
      // 同步到目标卡片
      const promptId = this.currentPreviewPrompt.id;
      console.log('[ComfyUI Panel] Overwrite prompt, id:', promptId, 'content length:', newContent.length);
      if (promptId) {
        this.loadPromptToCard(promptId, newContent);
      } else {
        this.showToast('已覆盖（未找到关联卡片）');
      }
    }

    // 快捷键注释支持 (Ctrl+/) 和保存支持 (Ctrl+S)
    handlePreviewKeydown(e) {
      // Ctrl+S 触发覆盖当前项
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        
        // 检查是否有当前预览的提示词
        if (this.currentPreviewIndex >= 0 && this.currentPreviewPrompt) {
          this.overwriteCurrentPrompt();
        } else {
          this.showToast('请先选择一个提示词项');
        }
        return;
      }
      
      // Ctrl+/ 注释/取消注释
      if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        const textarea = this.elements.promptPreviewTextarea;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;

        // 获取当前行
        const lineStart = value.lastIndexOf('\n', start - 1) + 1;
        const lineEnd = value.indexOf('\n', end);
        const actualLineEnd = lineEnd === -1 ? value.length : lineEnd;

        const currentLine = value.substring(lineStart, actualLineEnd);
        
        // 检查是否有选中文本（且选中文本在同一行内）
        const hasSelection = start !== end;
        const selectionInSameLine = start >= lineStart && end <= actualLineEnd;
        
        if (hasSelection && selectionInSameLine) {
          // 有选中文本且在同一行内，注释/取消注释选中的提示词
          const result = this.togglePromptComment(currentLine, start - lineStart, end - lineStart);
          if (result.modified) {
            const newValue = value.substring(0, lineStart) + result.line + value.substring(actualLineEnd);
            textarea.value = newValue;
            
            // 设置光标位置：移动到注释/取消注释的提示词的逗号后面
            const newCursorPos = lineStart + result.cursorOffset;
            textarea.setSelectionRange(newCursorPos, newCursorPos);
            
            // 触发input事件
            textarea.dispatchEvent(new Event('input'));
          }
        } else {
          // 没有选中文本或选中文本跨行，注释/取消注释整行
          const selectedLines = value.substring(lineStart, actualLineEnd);
          const lines = selectedLines.split('\n');

          // 检查是否所有行都以 # 开头
          const allCommented = lines.every(line => line.trim().startsWith('#') || line.trim() === '');

          let newLines;
          if (allCommented) {
            // 取消注释
            newLines = lines.map(line => {
              const trimmed = line.trim();
              if (trimmed.startsWith('#')) {
                const uncommented = trimmed.substring(1).trimStart();
                const leadingSpaces = line.length - line.trimStart().length;
                return ' '.repeat(leadingSpaces) + uncommented;
              }
              return line;
            });
          } else {
            // 添加注释
            newLines = lines.map(line => {
              if (line.trim() === '') return line;
              const leadingSpaces = line.length - line.trimStart().length;
              return ' '.repeat(leadingSpaces) + '# ' + line.trimStart();
            });
          }

          const newValue = value.substring(0, lineStart) + newLines.join('\n') + value.substring(actualLineEnd);
          textarea.value = newValue;

          // 设置光标位置：移动到行末尾
          const newLineEnd = lineStart + newLines.join('\n').length;
          textarea.setSelectionRange(newLineEnd, newLineEnd);

          // 触发input事件
          textarea.dispatchEvent(new Event('input'));
        }
      }
    }

    // 处理列表项按钮操作
    async handlePromptItemAction(action, index) {
      const prompt = this.promptLibrary[index];
      if (!prompt) return;

      switch (action) {
        case 'load':
          // 加载：使用预览框内容或原始内容加载到卡片
          this.loadPromptToCard(prompt.id, this.previewUnsaved ? this.elements.promptPreviewTextarea.value : prompt.content);
          break;
        case 'copy':
          // 复制：复制预览框内容或原始内容
          try {
            await navigator.clipboard.writeText(this.previewUnsaved ? this.elements.promptPreviewTextarea.value : prompt.content);
            this.showToast('已复制到剪贴板');
          } catch (e) {
            this.showToast('复制失败');
          }
          break;
        case 'replace':
          // 替换：用预览框内容或卡片内容替换列表项
          await this.replacePromptItem(index);
          break;
        case 'delete':
          // 删除
          this.deletePrompt(index);
          break;
      }
    }

    // 替换列表项内容
    async replacePromptItem(index) {
      const prompt = this.promptLibrary[index];
      if (!prompt) return;

      const textareaCards = this.getTextareaCards();
      const targetCard = textareaCards.find(c => c.fullKey === prompt.id);

      if (!targetCard) {
        this.showToast('对应ID的卡片不存在');
        return;
      }

      let newContent;
      if (this.previewUnsaved && this.currentPreviewIndex === index) {
        // 使用预览框编辑后的内容
        newContent = this.elements.promptPreviewTextarea.value;
      } else {
        // 使用卡片当前内容
        newContent = this.cardValues[prompt.id] || '';
      }

      if (!newContent) {
        this.showToast('内容为空');
        return;
      }

      const firstLine = newContent.split('\n')[0].trim() || '无标题';
      this.promptLibrary[index].title = firstLine;
      this.promptLibrary[index].content = newContent;

      await this.savePromptLibraryConfig();
      this.renderPromptLibraryList();
      this.previewUnsaved = false;
      this.showToast('已替换');
    }

    // 加载内容到卡片
    loadPromptToCard(cardFullKey, content) {
      // 直接使用传入的 cardFullKey 作为目标 key
      const targetKey = cardFullKey;
      
      console.log('[ComfyUI Panel] loadPromptToCard called, targetKey:', targetKey, 'content length:', content.length);

      // 更新卡片值（无论卡片是否在当前标签页都更新）
      this.cardValues[targetKey] = content;
      console.log('[ComfyUI Panel] Updated cardValues[' + targetKey + ']');

      // 更新UI（如果 textarea 存在于当前页面）
      const textarea = document.querySelector(`textarea[data-key="${targetKey}"]`);
      if (textarea) {
        textarea.value = content;
        textarea.dispatchEvent(new Event('input'));
        
        // 更新卡片的高亮显示
        const container = textarea.closest('.textarea-highlight-container');
        if (container) {
          const highlightPre = container.querySelector('.textarea-highlight-pre');
          if (highlightPre) {
            this.renderTextareaHighlight(highlightPre, content);
          }
        }
        console.log('[ComfyUI Panel] Updated textarea UI for:', targetKey);
      } else {
        console.log('[ComfyUI Panel] Textarea not found in current view, value saved to cardValues only');
      }

      // 更新标题显示已加载
      this.updatePreviewTitle(targetKey, { class: 'loaded-badge', text: '✓ 已加载' });
      this.showToast('已同步到卡片');
    }

    // 删除提示词
    async deletePrompt(index) {
      this.promptLibrary.splice(index, 1);
      await this.savePromptLibraryConfig();
      this.renderPromptLibraryList();
      // 清空预览
      this.elements.promptPreviewTextarea.value = '';
      if (this.elements.promptHighlightPre) {
        this.renderTextareaHighlight(this.elements.promptHighlightPre, '');
      }
      this.elements.promptPreviewTitle.innerHTML = '<span class="card-id"></span><span class="card-name"></span>';
      this.currentPreviewPrompt = null;
      this.currentPreviewIndex = -1;
      this.previewUnsaved = false;
      this.showToast('已删除');
    }

    // 加载提示词库
    loadPromptLibrary() {
      this.renderPromptLibraryList();
    }

    // 提示词库固定文件名
    getPromptLibraryFilename() {
      return 'comfyui_prompt_library.json';
    }

    // 保存提示词库配置
    async savePromptLibraryConfig() {
      const config = {
        promptLibrary: this.promptLibrary
      };

      try {
        const promptFilename = this.getPromptLibraryFilename();

        const response = await fetch(this.baseUrl + '/comfyui_panel/save_config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: promptFilename,
            config: config
          })
        });
        const result = await response.json();
        if (result.success) {
          console.log('[ComfyUI Panel] Prompt library saved:', result.filename);
        } else {
          console.error('[ComfyUI Panel] Failed to save prompt library:', result.error);
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Error saving prompt library:', e);
      }
    }

    // 加载提示词库配置
    async loadPromptLibraryConfig() {
      try {
        const promptFilename = this.getPromptLibraryFilename();

        const response = await fetch(this.baseUrl + '/comfyui_panel/load_config?name=' + encodeURIComponent(promptFilename));
        const data = await response.json();
        if (data.success && data.config && data.config.promptLibrary) {
          this.promptLibrary = data.config.promptLibrary;
          this.renderPromptLibraryList();
        }
      } catch (e) {
        console.log('[ComfyUI Panel] No prompt library config found or error loading:', e);
      }
    }

    toggleGallery() {
      // 如果当前活动面板是这个按钮，则返回卡片界面
      if (this.activePanelBtn === 'galleryBtn') {
        this.returnToCards();
        return;
      }
      
      // 打开图库面板
      this.setActivePanel('galleryBtn');
      this.hideAllPanels();
      this.elements.galleryPanel.classList.add('visible');
      this.elements.configContent.style.display = 'none';
      this.loadGalleryFiles();
    }

    async loadGalleryFiles() {
      try {
        // 清空图片缓存
        this.galleryImageCache = {};
        const response = await fetch(this.baseUrl + '/comfyui_panel/output_files?t=' + Date.now());
        const data = await response.json();
        if (data.success) {
          this.galleryFiles = data.files;
          this.renderGalleryFiles();
        } else {
          console.error('[ComfyUI Panel] Failed to load output files:', data.error);
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Error loading output files:', e);
      }
    }

    renderGalleryFiles() {
      const container = this.elements.galleryFiles;
      container.innerHTML = '';
      if (!this.galleryFiles.length) {
        container.innerHTML = '<div class="empty-state">暂无输出图片</div>';
        return;
      }

      // 视频文件扩展名
      const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.gif'];

      // 创建IntersectionObserver用于懒加载
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const img = entry.target;
            if (img.dataset.src) {
              img.src = img.dataset.src;
              img.removeAttribute('data-src');
              observer.unobserve(img);
            }
          }
        });
      }, { root: container, rootMargin: '200px' });

      this.galleryFiles.forEach((file, index) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        if (index === this.galleryCurrentIndex) item.classList.add('selected');
        item.dataset.index = index;

        // 检查是否为视频文件
        const fileName = file.name.toLowerCase();
        const isVideo = videoExtensions.some(ext => fileName.endsWith(ext));

        if (isVideo) {
          // 视频文件：不加载缩略图，显示视频图标
          item.innerHTML = `
            <div class="thumb-wrapper">
              <div class="thumb-placeholder">🎬</div>
              <div class="video-indicator">▶</div>
            </div>
            <div class="file-info">
              <span class="filename" title="${file.name}">${file.name}</span>
              <span class="filesize">${(file.size / 1024).toFixed(1)}KB</span>
            </div>
          `;
        } else {
          // 图片文件：懒加载缩略图
          const thumbUrl = this.baseUrl + `/view?filename=${encodeURIComponent(file.name)}&type=output&t=${Date.now()}`;

          item.innerHTML = `
            <div class="thumb-wrapper">
              <div class="thumb-placeholder">🖼</div>
              <img data-src="${thumbUrl}" alt="${file.name}">
            </div>
            <div class="file-info">
              <span class="filename" title="${file.name}">${file.name}</span>
              <span class="filesize">${(file.size / 1024).toFixed(1)}KB</span>
            </div>
          `;

          // 懒加载图片
          const img = item.querySelector('img');
          observer.observe(img);

          // 图片加载完成后显示
          img.onload = () => {
            img.classList.add('loaded');
            const placeholder = item.querySelector('.thumb-placeholder');
            if (placeholder) placeholder.style.display = 'none';
          };

          img.onerror = () => {
            img.style.display = 'none';
          };
        }

        // 鼠标悬停预览
        item.onmouseenter = () => this.selectGalleryFile(index);
        item.onclick = () => this.selectGalleryFile(index);

        container.appendChild(item);
      });
    }

    selectGalleryFile(index) {
      if (index < 0 || index >= this.galleryFiles.length) return;
      this.galleryCurrentIndex = index;
      const file = this.galleryFiles[index];
      document.querySelectorAll('.gallery-item').forEach(el => el.classList.remove('selected'));
      document.querySelector(`.gallery-item[data-index="${index}"]`)?.classList.add('selected');

      // 视频文件扩展名
      const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.gif'];
      const fileName = file.name.toLowerCase();
      const isVideo = videoExtensions.some(ext => fileName.endsWith(ext));

      if (isVideo) {
        // 视频文件：显示视频播放器
        const videoUrl = this.baseUrl + `/view?filename=${encodeURIComponent(file.name)}&type=output&t=${Date.now()}`;
        
        // 隐藏图片，显示视频
        this.elements.previewImage.style.display = 'none';
        this.elements.previewPlaceholder.style.display = 'none';
        this.elements.previewVideo.src = videoUrl;
        this.elements.previewVideo.style.display = 'block';
        this.elements.previewVideo.play();
        
        this.isVideoPreview = true;
        return;
      }

      // 图片文件：隐藏视频播放器
      this.elements.previewVideo.style.display = 'none';
      this.elements.previewVideo.pause();
      this.isVideoPreview = false;

      // 检查缓存中是否已有此图片
      if (this.galleryImageCache[file.name]) {
        // 使用缓存的图片
        this.setPreviewImage(this.galleryImageCache[file.name]);
      } else {
        // 加载图片并缓存
        const url = this.baseUrl + `/view?filename=${encodeURIComponent(file.name)}&type=output&t=${Date.now()}`;
        this.setPreviewImage(url);
        // 缓存URL供后续使用
        this.galleryImageCache[file.name] = url;
      }
    }

    setPreviewImage(url) {
      this.elements.previewPlaceholder.style.display = 'none';
      this.elements.previewVideo.style.display = 'none';
      this.elements.previewVideo.pause();
      this.elements.previewImage.src = url;
      this.elements.previewImage.style.display = 'block';
      // 设置背景图片（使用预加载避免闪烁）
      this.setBackgroundWithPreload(url);
      if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(this.previewUrl);
      }
      this.previewUrl = url;
      // 重置缩放和平移
      this.resetPreviewZoom();
    }

    /**
     * 使用预加载设置背景图片，避免切换时的空白闪烁
     * @param {string} url - 图片URL
     */
    setBackgroundWithPreload(url) {
      // 如果URL为空或与当前背景相同，不做任何操作
      if (!url) return;
      
      const currentBg = this.elements.previewContentBg?.style.backgroundImage || '';
      if (currentBg.includes(url)) return;
      
      // 创建一个临时图片来预加载
      const preloadImg = new Image();
      
      preloadImg.onload = () => {
        // 图片加载完成后，同时更新两个背景
        // 左侧预览窗口背景图（无磨砂效果）
        if (this.elements.previewContentBg) {
          this.elements.previewContentBg.style.backgroundImage = `url(${url})`;
        }
        // 右侧面板背景图（有磨砂效果）
        if (this.elements.contentBg) {
          this.elements.contentBg.style.backgroundImage = `url(${url})`;
        }
      };
      
      preloadImg.onerror = () => {
        console.warn('[ComfyUI Panel] Failed to preload background image:', url);
      };
      
      preloadImg.src = url;
      
      // 如果图片已经缓存，立即设置
      if (preloadImg.complete) {
        if (this.elements.previewContentBg) {
          this.elements.previewContentBg.style.backgroundImage = `url(${url})`;
        }
        if (this.elements.contentBg) {
          this.elements.contentBg.style.backgroundImage = `url(${url})`;
        }
      }
    }

    selectPrevGalleryFile() {
      if (this.galleryFiles.length === 0) return;
      let newIndex = this.galleryCurrentIndex - 1;
      if (newIndex < 0) newIndex = this.galleryFiles.length - 1;
      this.selectGalleryFile(newIndex);
    }

    selectNextGalleryFile() {
      if (this.galleryFiles.length === 0) return;
      let newIndex = this.galleryCurrentIndex + 1;
      if (newIndex >= this.galleryFiles.length) newIndex = 0;
      this.selectGalleryFile(newIndex);
    }

    async clearInputFiles() {
      if (!confirm('确定要清空输入目录的所有文件吗？此操作不可撤销！')) return;
      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/clear_input_files', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
          this.showToast(`已清空输入目录: ${data.deleted_count || 0} 个文件`);
        } else {
          this.showToast('清空失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Clear input files failed:', e);
        this.showToast('清空失败');
      }
    }

    async clearOutputFiles() {
      if (!confirm('确定要清空输出目录的所有文件吗？此操作不可撤销！')) return;
      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/clear_output_files', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
          this.showToast(`已清空输出目录: ${data.deleted_count || 0} 个文件`);
          // 清空后刷新图库
          this.galleryFiles = [];
          this.galleryCurrentIndex = -1;
          this.renderGalleryFiles();
          // 清空预览
          this.elements.previewImage.style.display = 'none';
          this.elements.previewPlaceholder.style.display = 'flex';
          this.previewUrl = null;
        } else {
          this.showToast('清空失败: ' + (data.error || '未知错误'));
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Clear output files failed:', e);
        this.showToast('清空失败');
      }
    }

    getImageUploadContainerAtMouse() {
      const elements = document.elementsFromPoint(this.lastMouseX, this.lastMouseY);
      for (const el of elements) {
        if (el.classList && el.classList.contains('image-upload-container')) {
          return el;
        }
      }
      return null;
    }

    async pasteImageAtMouse() {
      const container = this.getImageUploadContainerAtMouse();
      if (!container) {
        this.showToast('鼠标下没有图片加载面板');
        return;
      }

      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              await this.loadImageToContainer(container, blob, 'pasted_image.png');
              this.showToast('图片已粘贴');
              return;
            }
          }
        }
        this.showToast('剪贴板中没有图像');
      } catch (e) {
        console.error('[ComfyUI Panel] Paste failed:', e);
        this.showToast('粘贴失败: ' + e.message);
      }
    }

    async loadImageToContainer(container, blob, filename) {
      const url = URL.createObjectURL(blob);
      const img = new Image();

      return new Promise((resolve, reject) => {
        img.onload = () => {
          const imageUploadData = this.findImageUploadData(container);
          if (imageUploadData && imageUploadData.handleImageLoad) {
            imageUploadData.handleImageLoad(img, filename);
          }
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('图片加载失败'));
        };
        img.src = url;
      });
    }

    findImageUploadData(container) {
      for (const [key, data] of Object.entries(this.imageCropData)) {
        if (data.container === container) {
          return data;
        }
      }
      return null;
    }

    async downloadCurrentImage() {
      // 防止重复下载
      if (this.isDownloading) return;

      // 如果是生成过程中的预览图，不下载
      if (this.isPreviewGenerating) {
        this.showToast('生成中，请等待完成');
        return;
      }

      // 图库模式下下载当前预览的图库图片
      if (this.elements.galleryPanel.classList.contains('visible')) {
        if (this.galleryCurrentIndex >= 0 && this.galleryCurrentIndex < this.galleryFiles.length) {
          const file = this.galleryFiles[this.galleryCurrentIndex];

          // 检查是否已下载过此文件
          if (this.lastDownloadedFile === file.name) {
            // 已下载过，触发生成（加入队列）
            this.elements.generateBtn.click();
            return;
          }

          this.isDownloading = true;
          const url = this.baseUrl + `/view?filename=${encodeURIComponent(file.name)}&type=output`;
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = file.name;
            a.click();
            URL.revokeObjectURL(blobUrl);
            this.lastDownloadedFile = file.name;
            this.showToast(`已下载: ${file.name}`);
          } catch (e) {
            console.error('[ComfyUI Panel] Download gallery file failed:', e);
            this.showToast('下载失败');
          } finally {
            this.isDownloading = false;
          }
          return;
        }
        return;
      }

      // F键只下载预览区域的大图，不下载缩略图

      // 如果当前结果已下载，触发运行（加入队列）
      if (this.currentResult && this.currentResult.downloaded) {
        this.elements.generateBtn.click();
        return;
      }

      if (this.generatedImages.length === 0 && !this.previewUrl && this.generatedVideos.length === 0) return;

      try {
        let url, filename;

        // 优先处理视频
        if (this.generatedVideos.length > 0) {
          const video = this.generatedVideos[0];
          url = this.baseUrl + `/view?filename=${encodeURIComponent(video.filename)}&type=${video.type}&subfolder=${video.subfolder || ''}`;
          filename = video.filename;
        } else if (this.generatedImages.length > 0) {
          const img = this.generatedImages[0];
          url = this.baseUrl + `/view?filename=${encodeURIComponent(img.filename)}&type=${img.type}&subfolder=${img.subfolder || ''}`;
          filename = img.filename;
        } else if (this.previewUrl) {
          url = this.previewUrl;
          filename = 'preview.png';
        } else {
          return;
        }

        // 检查是否已下载过此文件
        if (this.lastDownloadedFile === filename) {
          // 已下载过，触发生成（加入队列）
          this.elements.generateBtn.click();
          return;
        }

        // 如果当前结果已下载，触发运行（加入队列）
        if (this.currentResult && this.currentResult.filename === filename && this.currentResult.downloaded) {
          this.elements.generateBtn.click();
          return;
        }

        this.isDownloading = true;
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(blobUrl);

        // 标记当前结果为已下载
        if (this.currentResult) {
          this.currentResult.downloaded = true;
        }
        this.lastDownloadedFile = filename;
      } catch (e) {
        console.error('[ComfyUI Panel] Download failed:', e);
      } finally {
        this.isDownloading = false;
      }
    }

    async copyCurrentImage() {
      // 如果是视频预览，不支持复制
      if (this.isVideoPreview) {
        this.showToast('视频不支持复制到剪贴板');
        return;
      }

      // 图库模式下复制当前预览的图库图片
      if (this.elements.galleryPanel.classList.contains('visible')) {
        if (this.galleryCurrentIndex >= 0 && this.galleryCurrentIndex < this.galleryFiles.length) {
          const file = this.galleryFiles[this.galleryCurrentIndex];
          
          // 检查是否为视频文件
          const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.gif'];
          const fileName = file.name.toLowerCase();
          const isVideo = videoExtensions.some(ext => fileName.endsWith(ext));
          if (isVideo) {
            this.showToast('视频不支持复制到剪贴板');
            return;
          }
          
          const url = this.baseUrl + `/view?filename=${encodeURIComponent(file.name)}&type=output`;
          try {
            const response = await fetch(url);
            const blob = await response.blob();
            // 转换为 PNG 格式以确保剪贴板兼容性
            const pngBlob = await this.convertToPNG(blob);
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
            this.showToast(`已复制: ${file.name}`);
          } catch (e) {
            console.error('[ComfyUI Panel] Copy gallery file failed:', e);
            this.showToast('复制失败: ' + e.message);
          }
          return;
        }
        return;
      }

      // 优先使用最终生成的图片，而不是过程预览图
      let url = null;
      if (this.generatedImages.length > 0) {
        const img = this.generatedImages[0];
        url = this.baseUrl + `/view?filename=${encodeURIComponent(img.filename)}&type=${img.type}&subfolder=${img.subfolder || ''}`;
      } else if (this.previewUrl && !this.isPreviewGenerating) {
        // 只有在没有最终生成图片且不是生成过程中的预览图时，才使用 previewUrl
        url = this.previewUrl;
      }
      
      if (!url) {
        this.showToast('没有图片可复制');
        return;
      }
      
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        // 转换为 PNG 格式以确保剪贴板兼容性
        const pngBlob = await this.convertToPNG(blob);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
        this.showToast('图片已复制到剪贴板');
      } catch (e) {
        console.error('[ComfyUI Panel] Copy failed:', e);
        this.showToast('复制失败: ' + e.message);
      }
    }

    // 将图片 blob 转换为 PNG 格式
    async convertToPNG(blob) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((pngBlob) => {
            if (pngBlob) {
              resolve(pngBlob);
            } else {
              reject(new Error('Failed to convert to PNG'));
            }
          }, 'image/png');
          URL.revokeObjectURL(img.src);
        };
        img.onerror = () => {
          URL.revokeObjectURL(img.src);
          reject(new Error('Failed to load image'));
        };
        img.src = URL.createObjectURL(blob);
      });
    }

    bindResizer() {
      const resizer = this.elements.resizer;
      const previewPanel = this.elements.previewPanel;
      let isDragging = false;

      resizer.addEventListener('mousedown', (e) => {
        isDragging = true;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const newWidthPercent = (e.clientX / window.innerWidth) * 100;

        if (newWidthPercent >= 20 && newWidthPercent <= 80) {
          previewPanel.style.width = newWidthPercent + '%';
        }
      });

      document.addEventListener('mouseup', () => {
        if (isDragging) {
          isDragging = false;
          resizer.classList.remove('dragging');
          document.body.style.cursor = '';
        }
      });

      const dragHandle = document.getElementById('drag-handle');
      const mainPanel = document.getElementById('comfyui-panel-main');
      let isPanelDragging = false;
      let panelOffsetY = 0;

      if (dragHandle) {
        dragHandle.addEventListener('mousedown', (e) => {
          isPanelDragging = true;
          dragHandle.classList.add('dragging');
          document.body.style.cursor = 'grabbing';
          panelOffsetY = e.clientY - mainPanel.offsetTop;
          e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
          if (!isPanelDragging) return;
          const newTop = e.clientY - panelOffsetY;
          if (newTop >= 0 && newTop <= window.innerHeight - 100) {
            mainPanel.style.top = newTop + 'px';
          }
        });

        document.addEventListener('mouseup', () => {
          if (isPanelDragging) {
            isPanelDragging = false;
            dragHandle.classList.remove('dragging');
            document.body.style.cursor = '';
          }
        });
      }
    }

    bindPreviewZoomEvents() {
      const container = this.elements.previewContainer;
      const image = this.elements.previewImage;
      
      // 鼠标滚轮缩放
      container.addEventListener('wheel', (e) => {
        if (image.style.display === 'none') return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // 计算鼠标相对于图像中心的位置
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        // 缩放因子
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.1, Math.min(10, this.previewZoom * zoomFactor));
        
        // 计算缩放后鼠标位置对应的图像坐标变化
        // 以鼠标位置为锚点进行缩放
        const scale = newZoom / this.previewZoom;
        
        // 计算鼠标位置在图像坐标系中的位置（缩放前）
        const imgX = (mouseX - this.previewPanX) / this.previewZoom;
        const imgY = (mouseY - this.previewPanY) / this.previewZoom;
        
        // 更新缩放值
        this.previewZoom = newZoom;
        
        // 计算新的平移量，使鼠标位置对应的图像点保持在屏幕上的同一位置
        this.previewPanX = mouseX - imgX * newZoom;
        this.previewPanY = mouseY - imgY * newZoom;
        
        this.updatePreviewTransform();
        this.showZoomInfo();
      }, { passive: false });
      
      // 鼠标拖拽平移
      container.addEventListener('mousedown', (e) => {
        // 清除当前焦点元素（如输入框），以便快捷键能正常工作
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }

        if (image.style.display === 'none') return;
        if (e.button !== 0) return; // 只响应左键
        
        this.isDraggingPreview = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartPanX = this.previewPanX;
        this.dragStartPanY = this.previewPanY;
        
        container.classList.add('dragging');
        // 禁用 transition，确保拖拽时图片立即跟随鼠标
        image.classList.add('no-transition');
        // 禁用右侧面板的交互，防止抖动
        this.elements.configContent.classList.add('preview-dragging');
        e.preventDefault();
        e.stopPropagation();
      });
      
      document.addEventListener('mousemove', (e) => {
        // 如果右侧面板正在拖拽滚动，不处理预览图的拖拽
        if (this.isDragScrolling) return;
        if (!this.isDraggingPreview) return;
        
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        
        this.previewPanX = this.dragStartPanX + dx;
        this.previewPanY = this.dragStartPanY + dy;
        
        this.updatePreviewTransform();
      });
      
      document.addEventListener('mouseup', () => {
        if (this.isDraggingPreview) {
          this.isDraggingPreview = false;
          container.classList.remove('dragging');
          // 恢复 transition
          image.classList.remove('no-transition');
          // 恢复右侧面板的交互
          this.elements.configContent.classList.remove('preview-dragging');
        }
      });
      
      // 双击重置缩放和平移
      container.addEventListener('dblclick', (e) => {
        if (e.ctrlKey) return; // Ctrl+双击用于注释功能，这里不处理
        if (image.style.display === 'none') return;
        
        this.resetPreviewZoom();
      });
    }
    
    updatePreviewTransform() {
      const image = this.elements.previewImage;
      image.style.transform = `translate(${this.previewPanX}px, ${this.previewPanY}px) scale(${this.previewZoom})`;
    }
    
    updatePreviewBackground(url) {
      // 使用预加载更新背景图片
      if (url) {
        this.setBackgroundWithPreload(url);
      }
    }
    
    showZoomInfo() {
      const zoomInfo = this.elements.previewZoomInfo;
      zoomInfo.textContent = Math.round(this.previewZoom * 100) + '%';
      zoomInfo.classList.add('visible');
      
      // 清除之前的定时器
      if (this._zoomInfoTimer) {
        clearTimeout(this._zoomInfoTimer);
      }
      
      // 2秒后隐藏
      this._zoomInfoTimer = setTimeout(() => {
        zoomInfo.classList.remove('visible');
      }, 2000);
    }
    
    resetPreviewZoom() {
      this.previewZoom = 1;
      this.previewPanX = 0;
      this.previewPanY = 0;
      this.updatePreviewTransform();
      this.showZoomInfo();
    }

    // 缩略图缩放和拖拽事件绑定
    bindThumbZoomEvents() {
      const container = this.elements.previousResultThumb;
      const image = this.elements.thumbImage;
      
      // 鼠标滚轮缩放
      container.addEventListener('wheel', (e) => {
        if (!container.classList.contains('expanded')) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        // 缩放因子
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.1, Math.min(10, this.thumbZoom * zoomFactor));
        
        // 以鼠标位置为锚点进行缩放
        const scale = newZoom / this.thumbZoom;
        const imgX = (mouseX - this.thumbPanX) / this.thumbZoom;
        const imgY = (mouseY - this.thumbPanY) / this.thumbZoom;
        
        this.thumbZoom = newZoom;
        this.thumbPanX = mouseX - imgX * newZoom;
        this.thumbPanY = mouseY - imgY * newZoom;
        
        this.updateThumbTransform();
      }, { passive: false });
      
      // 鼠标拖拽平移
      container.addEventListener('mousedown', (e) => {
        if (!container.classList.contains('expanded')) return;
        if (e.button !== 0) return; // 只响应左键
        
        this.isDraggingThumb = true;
        this.thumbDragStartX = e.clientX;
        this.thumbDragStartY = e.clientY;
        this.thumbDragStartPanX = this.thumbPanX;
        this.thumbDragStartPanY = this.thumbPanY;
        
        container.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
      });
      
      document.addEventListener('mousemove', (e) => {
        if (!this.isDraggingThumb) return;
        
        const dx = e.clientX - this.thumbDragStartX;
        const dy = e.clientY - this.thumbDragStartY;
        
        this.thumbPanX = this.thumbDragStartPanX + dx;
        this.thumbPanY = this.thumbDragStartPanY + dy;
        
        this.updateThumbTransform();
      });
      
      document.addEventListener('mouseup', () => {
        if (this.isDraggingThumb) {
          this.isDraggingThumb = false;
          container.style.cursor = '';
        }
      });
      
      // 双击重置缩放和平移
      container.addEventListener('dblclick', (e) => {
        if (!container.classList.contains('expanded')) return;
        
        this.thumbZoom = 1;
        this.centerThumbImage();
      });
    }
    
    // 更新缩略图变换
    updateThumbTransform() {
      const image = this.elements.thumbImage;
      if (image) {
        // 设置 transform-origin 为左上角，这样平移和缩放的计算更直观
        image.style.transformOrigin = '0 0';
        image.style.transform = `translate(${this.thumbPanX}px, ${this.thumbPanY}px) scale(${this.thumbZoom})`;
      }
    }
    
    // 让缩略图居中显示
    centerThumbImage() {
      const container = this.elements.previousResultThumb;
      const image = this.elements.thumbImage;
      
      if (!container || !image) return;
      
      // 获取容器和图片的尺寸
      const containerRect = container.getBoundingClientRect();
      const imgWidth = image.naturalWidth || image.width;
      const imgHeight = image.naturalHeight || image.height;
      
      if (imgWidth && imgHeight) {
        // 计算让图片居中的平移量
        this.thumbPanX = (containerRect.width - imgWidth) / 2;
        this.thumbPanY = (containerRect.height - imgHeight) / 2;
      } else {
        this.thumbPanX = 0;
        this.thumbPanY = 0;
      }
      
      this.updateThumbTransform();
    }

    bindDragScroll() {
      const container = this.elements.configContent;
      
      // 鼠标按下开始拖拽
      container.addEventListener('mousedown', (e) => {
        // 如果点击的是输入框、文本域、选择框等交互元素，不触发拖拽
        const tagName = e.target.tagName.toLowerCase();
        if (['input', 'textarea', 'select', 'button', 'a', 'label'].includes(tagName)) return;
        if (e.target.closest('input, textarea, select, button, a, label')) return;
        // 如果点击的是折叠状态下的卡片标题栏，不触发拖拽滑动（标题栏有拖拽排序功能）
        // 展开状态下的标题栏可以触发拖拽滑动
        const cardHeader = e.target.closest('.config-card-header');
        if (cardHeader) {
          const card = cardHeader.closest('.config-card');
          if (card && card.classList.contains('collapsed')) return;
        }
        // 如果点击的是图像上传/裁剪区域，不触发拖拽
        if (e.target.closest('.image-upload-container, .image-preview-wrapper, .crop-overlay, .crop-box')) return;
        // 如果点击的是多行文本编辑框容器（包括空白区域），不触发拖拽
        if (e.target.closest('.textarea-highlight-container')) return;
        
        this.isDragScrolling = true;
        this.dragScrollStartY = e.clientY;
        this.dragScrollStartTop = container.scrollTop;
        this.dragScrollLastY = e.clientY;
        this.dragScrollLastTime = Date.now();
        this.dragScrollVelocity = 0;
        
        // 取消之前的惯性动画
        if (this.dragScrollAnimationId) {
          cancelAnimationFrame(this.dragScrollAnimationId);
          this.dragScrollAnimationId = null;
        }
        
        container.style.cursor = 'grabbing';
        container.style.userSelect = 'none';
        e.preventDefault();
      });
      
      // 鼠标移动时滚动
      document.addEventListener('mousemove', (e) => {
        // 如果预览图正在拖拽，不处理右侧面板的拖拽滚动
        if (this.isDraggingPreview) return;
        if (!this.isDragScrolling) return;
        
        const deltaY = this.dragScrollStartY - e.clientY;
        container.scrollTop = this.dragScrollStartTop + deltaY;
        
        // 计算速度（用于惯性滚动）
        const now = Date.now();
        const dt = now - this.dragScrollLastTime;
        if (dt > 0) {
          // 使用指数移动平均平滑速度
          const instantVelocity = (this.dragScrollLastY - e.clientY) / dt;
          this.dragScrollVelocity = this.dragScrollVelocity * 0.6 + instantVelocity * 0.4;
        }
        this.dragScrollLastY = e.clientY;
        this.dragScrollLastTime = now;
      });
      
      // 鼠标释放结束拖拽，启动惯性滚动
      document.addEventListener('mouseup', () => {
        if (this.isDragScrolling) {
          this.isDragScrolling = false;
          container.style.cursor = '';
          container.style.userSelect = '';
          
          // 启动惯性滚动
          if (Math.abs(this.dragScrollVelocity) > 0.3) {
            this.startInertiaScroll(container);
          }
        }
      });
    }
    
    // 惯性滚动动画
    startInertiaScroll(container) {
      let velocity = this.dragScrollVelocity;
      const friction = 0.96; // 摩擦系数，越大减速越慢，惯性越大
      const minVelocity = 0.03; // 最小速度阈值
      
      const animate = () => {
        if (Math.abs(velocity) < minVelocity) {
          this.dragScrollAnimationId = null;
          return;
        }
        
        // 应用速度（速度方向与鼠标移动方向一致，滚动方向与速度方向一致）
        container.scrollTop += velocity * 16; // 标准化为每帧位移
        
        // 应用摩擦力
        velocity *= friction;
        
        // 边界检测，到达边界时停止
        const atTop = container.scrollTop <= 0;
        const atBottom = container.scrollTop >= container.scrollHeight - container.clientHeight;
        if (atTop || atBottom) {
          this.dragScrollAnimationId = null;
          return;
        }
        
        this.dragScrollAnimationId = requestAnimationFrame(animate);
      };
      
      this.dragScrollAnimationId = requestAnimationFrame(animate);
    }

    startQueueCheck() {
      // 立即检查一次
      this.checkQueueStatus();
      
      // 每2秒检查一次队列状态
      this.queueCheckInterval = setInterval(() => {
        this.checkQueueStatus();
      }, 2000);
    }

    async checkQueueStatus() {
      try {
        const response = await fetch(this.baseUrl + '/queue?t=' + Date.now());
        if (!response.ok) return;
        
        const data = await response.json();
        // queue_running 是正在执行的任务，queue_pending 是等待中的任务
        const running = data.queue_running?.length || 0;
        const pending = data.queue_pending?.length || 0;
        this.queueRemaining = running + pending;
        
        this.updateQueueDisplay();
        
        // 更新执行状态
        if (running > 0 && !this.isExecuting) {
          this.isExecuting = true;
          this.elements.statusDot?.classList.add('executing');
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Check queue failed:', e);
      }
    }

    updateQueueDisplay() {
      const count = this.queueRemaining;
      this.elements.queueCount.textContent = count;
      
      // 根据队列数量更新样式
      if (count > 0) {
        this.elements.queueInfo.classList.add('has-queue');
      } else {
        this.elements.queueInfo.classList.remove('has-queue');
      }
    }

    bindWebSocketEvents() {
      // 检测是否是真正的独立模式（在独立HTML中运行）
      // window.COMFYUI_PANEL_STANDALONE 是在独立HTML中设置的标志
      const isExplicitStandalone = window.COMFYUI_PANEL_STANDALONE === true;
      
      // ComfyUI 嵌入模式：使用 app.api 的事件监听
      // 注意：需要轮询等待 app 初始化完成
      const checkApp = () => {
        // 如果明确是独立模式，不再轮询
        if (isExplicitStandalone) {
          console.log('[ComfyUI Panel] Explicit standalone mode, skip WebSocket events binding');
          return;
        }
        
        // 检查 app 是否已初始化
        if (typeof app !== 'undefined' && app.api) {
          console.log('[ComfyUI Panel] App detected, binding WebSocket events');
          
          // 更新运行模式标志
          this.isStandaloneMode = false;
          this.isConnected = true;
          this.connectionStatus = 'connected';
          
          this.clientId = app.api.clientId;

          app.api.addEventListener('progress', (e) => { if (e.detail) this.updateProgress(e.detail.value, e.detail.max); });

          // progress_state 事件 - 每个步骤结束时发送
          app.api.addEventListener('progress_state', (e) => {
            // 步骤结束，开始播放帧动画
            if (this.isVideoGeneration && this.previewFrames.length > 1) {
              this.startFrameAnimation();
            }
          });

          app.api.addEventListener('executing', (e) => {
            if (e.detail === null || e.detail?.node === null) {
              this.onExecutionComplete();
              this.checkQueueStatus();
            }
          });

          app.api.addEventListener('execution_complete', (e) => {
            this.onExecutionComplete();
            this.checkQueueStatus();
          });

          app.api.addEventListener('executed', (e) => {
            if (!e.detail) return;

            const promptId = e.detail.prompt_id;
            const nodeId = e.detail.node;
            const output = e.detail.output;

            // 详细日志：输出完整的 output 结构
            // console.log('[ComfyUI Panel] executed event:', {
            //   prompt_id: promptId,
            //   node: nodeId,
            //   output: output,
            //   outputNodeIds: Array.from(this.outputNodeIds),
            //   isCurrentPrompt: this.currentPromptId === promptId
            // });



            // 详细日志：输出完整的 output 结构
            // console.log('[ComfyUI Panel] executed event:', {
            //   prompt_id: promptId,
            //   node: nodeId,
            //   output: output,
            //   outputNodeIds: Array.from(this.outputNodeIds),
            //   isCurrentPrompt: this.currentPromptId === promptId
            // });

            if (this.currentPromptId && promptId === this.currentPromptId) {
              if (this.outputNodeIds.has(nodeId)) {
                this.completedOutputNodes.add(nodeId);
                // console.log('[ComfyUI Panel] Output node completed:', nodeId,
                //   'progress:', this.completedOutputNodes.size, '/', this.outputNodeIds.size);
              }
            }

            // 检查所有可能的输出字段
            // if (output) {
            //   console.log('[ComfyUI Panel] Output keys:', Object.keys(output));
            //   console.log('[ComfyUI Panel] OutputNodeIds:', Array.from(this.outputNodeIds));
            //   console.log('[ComfyUI Panel] Current nodeId:', nodeId, 'hasNode:', this.outputNodeIds.has(nodeId));
            // }

            // 检查 outputNodeIds 是否包含此节点
            const isOutputNode = this.outputNodeIds.has(nodeId);
            
            // 检查是否有视频输出（不管是否在 outputNodeIds 中）
            const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.gif'];
            let hasVideoOutput = false;
            
            // 检查 images 中是否有视频文件
            if (output?.images) {
              for (const img of output.images) {
                const fileName = img.filename.toLowerCase();
                if (videoExtensions.some(ext => fileName.endsWith(ext))) {
                  hasVideoOutput = true;
                  break;
                }
              }
            }
            
            // 检查 videos 和 gifs 字段
            if (output?.videos || output?.gifs) {
              hasVideoOutput = true;
            }
            
            // 如果有视频输出，直接处理（不管是否在 outputNodeIds 中）
            if (hasVideoOutput) {
              // console.log('[ComfyUI Panel] Found video output, processing...');
              
              // 处理 images 中的视频
              if (output?.images) {
                const videos = [];
                const images = [];
                
                output.images.forEach(img => {
                  const fileName = img.filename.toLowerCase();
                  const isVideo = videoExtensions.some(ext => fileName.endsWith(ext));
                  // console.log('[ComfyUI Panel] Checking file:', img.filename, 'isVideo:', isVideo);
                  if (isVideo) {
                    videos.push(img);
                  } else {
                    images.push(img);
                  }
                });
                
                if (videos.length > 0) {
                  // console.log('[ComfyUI Panel] Found videos in images output:', videos);
                  this.onVideosGenerated(videos, nodeId);
                }
                if (images.length > 0 && isOutputNode) {
                  // console.log('[ComfyUI Panel] Found images in output:', images.length);
                  this.onImagesGenerated(images, nodeId);
                }
              }
              
              // 处理 videos 字段
              if (output?.videos) {
                // console.log('[ComfyUI Panel] Found videos output:', output.videos);
                this.onVideosGenerated(output.videos, nodeId);
              }
              
              // 处理 gifs 字段
              if (output?.gifs) {
                // console.log('[ComfyUI Panel] Found gifs output:', output.gifs);
                this.onVideosGenerated(output.gifs, nodeId);
              }
            } else if (isOutputNode) {
              // 没有视频输出，但节点在 outputNodeIds 中，处理图像
              if (output?.images) {
                // console.log('[ComfyUI Panel] Processing images for output node');
                this.onImagesGenerated(output.images, nodeId);
              }
            } else if (output?.images) {
              // console.log('[ComfyUI Panel] Has images but nodeId not in outputNodeIds and no video. nodeId:', nodeId);
            }
          });

          app.api.addEventListener('execution_error', (e) => {
            // console.log('[ComfyUI Panel] execution_error event:', e.detail);
            this.onExecutionError(e.detail);
            // 执行错误后检查队列状态
            this.checkQueueStatus();
          });

          // 监听 VHS_latentpreview 事件 - 只在第一个采样器步骤开始时发送
          app.api.addEventListener('VHS_latentpreview', (e) => {
            // console.log('[ComfyUI Panel] VHS_latentpreview event:', e.detail);
            if (e.detail && e.detail.length > 0) {
              // 第一个采样器步骤开始，设置视频生成模式
              this.isVideoGeneration = true;
              this.videoTotalFrames = e.detail.length;
              this.videoRate = e.detail.rate || 16;
              // 清空之前收集的帧
              this.clearPreviewFrames();
              // console.log('[ComfyUI Panel] Video generation started, total frames:', this.videoTotalFrames, 'rate:', this.videoRate);
            }
          });

          const originalOnMessage = app.api.socket.onmessage;
          app.api.socket.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) this.handleBinaryMessage(event.data);
            // 处理 JSON 消息
            if (typeof event.data === 'string') {
              try {
                const msg = JSON.parse(event.data);
                
                // VHS_latentpreview - 只在第一个采样器步骤开始时发送
                if (msg.type === 'VHS_latentpreview' && msg.data && msg.data.length > 0) {
                  this.isVideoGeneration = true;
                  this.videoTotalFrames = msg.data.length;
                  this.videoRate = msg.data.rate || 16;
                  this.clearPreviewFrames();
                  // console.log('[ComfyUI Panel] Video generation started (JSON), total frames:', this.videoTotalFrames);
                }
                
                // progress_state - 每个步骤结束时发送
                if (msg.type === 'progress_state') {
                  // console.log('[ComfyUI Panel] progress_state (JSON):', msg.data);
                  // 步骤结束，开始播放帧动画
                  if (this.isVideoGeneration && this.previewFrames.length > 1) {
                    // console.log('[ComfyUI Panel] Step complete (JSON), starting frame animation, frames:', this.previewFrames.length);
                    this.startFrameAnimation();
                  }
                }
              } catch (e) {}
            }
            if (originalOnMessage) originalOnMessage.call(app.api.socket, event);
          };
        } else { setTimeout(checkApp, 100); }
      };
      checkApp();
    }

    handleBinaryMessage(data) {
      try {
        const view = new DataView(data);
        const eventType = view.getInt32(0, false);

        if (eventType === 4) {
          // 图像预览格式：[4字节事件类型=4][4字节JSON长度][JSON数据][图像数据]
          const jsonLength = view.getInt32(4, false);
          const jsonStart = 8;
          const jsonEnd = jsonStart + jsonLength;

          if (jsonLength > 0 && jsonLength < data.byteLength - jsonStart) {
            const imageData = data.slice(jsonEnd);
            const imageHeader = new Uint8Array(imageData, 0, Math.min(12, imageData.byteLength));

            let mimeType = 'image/jpeg';
            if (imageHeader[0] === 0xFF && imageHeader[1] === 0xD8 && imageHeader[2] === 0xFF) {
              mimeType = 'image/jpeg';
            } else if (imageHeader[0] === 0x89 && imageHeader[1] === 0x50 && imageHeader[2] === 0x4E && imageHeader[3] === 0x4E) {
              mimeType = 'image/png';
            } else if (imageHeader[0] === 0x52 && imageHeader[1] === 0x49 && imageHeader[2] === 0x46 && imageHeader[3] === 0x46) {
              mimeType = 'image/webp';
            }

            const blob = new Blob([imageData], { type: mimeType });

            // 收到过程预览图时，将当前结果移动到上一个结果（缩略图）
            if (this.currentResult && !this.isPreviewGenerating) {
              this.previousResult = { ...this.currentResult };
              this.updatePreviousResultThumb();
            }

            if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
              URL.revokeObjectURL(this.previewUrl);
            }

            this.previewUrl = URL.createObjectURL(blob);
            this.isPreviewGenerating = true;  // 标记为过程预览

            // 隐藏视频，显示图片
            this.elements.previewVideo.style.display = 'none';
            this.elements.previewVideoInfo.classList.remove('visible');
            
            this.elements.previewPlaceholder.style.display = 'none';
            this.elements.previewImage.src = this.previewUrl;
            this.elements.previewImage.style.display = 'block';
            // 不在生成过程中更新背景图
            this.resetPreviewZoom();
          }
        } else if (eventType === 1) {
          // 视频帧预览格式：[4字节事件类型=1][4字节保留][4字节帧索引][4字节???][16字节节点ID][JPEG数据]
          // 总共 32 字节头部
          
          // 读取帧索引（第9-12字节，大端序）
          const frameIndex = view.getInt32(8, false);
          
          // 尝试从第32字节开始读取图像数据
          let imageData = data.slice(32);
          let imageHeader = new Uint8Array(imageData, 0, Math.min(12, imageData.byteLength));
          
          // 检查是否为 JPEG 或 PNG
          let isJpeg = imageHeader[0] === 0xFF && imageHeader[1] === 0xD8;
          let isPng = imageHeader[0] === 0x89 && imageHeader[1] === 0x50 && imageHeader[2] === 0x4E && imageHeader[3] === 0x4E;
          
          // 如果第32字节开始不是有效图像，尝试从第8字节开始（兼容旧格式）
          if (!isJpeg && !isPng) {
            imageData = data.slice(8);
            imageHeader = new Uint8Array(imageData, 0, Math.min(12, imageData.byteLength));
            isJpeg = imageHeader[0] === 0xFF && imageHeader[1] === 0xD8;
            isPng = imageHeader[0] === 0x89 && imageHeader[1] === 0x50 && imageHeader[2] === 0x4E && imageHeader[3] === 0x4E;
          }
          
          if (isJpeg || isPng) {
            const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
            const blob = new Blob([imageData], { type: mimeType });
            const blobUrl = URL.createObjectURL(blob);

            // 如果是视频生成模式，收集帧
            if (this.isVideoGeneration) {
              // 收集帧到数组
              this.previewFrames.push(blobUrl);
              
              // 更新帧信息显示
              this.elements.videoFrameInfo.textContent = `帧: ${this.previewFrames.length}/${this.videoTotalFrames}`;
              this.elements.previewVideoInfo.classList.add('visible');
              
              // 只有在没有播放动画时才更新显示
              if (!this.frameAnimationId) {
                this.elements.previewVideo.style.display = 'none';
                this.elements.previewPlaceholder.style.display = 'none';
                this.elements.previewImage.src = blobUrl;
                this.elements.previewImage.style.display = 'block';
                // 不在生成过程中更新背景图
              }
              
              // console.log('[ComfyUI Panel] Frame collected:', frameIndex, 'total:', this.previewFrames.length);
            } else {
              // 不是视频生成模式，按普通图像预览处理
              if (this.currentResult && !this.isPreviewGenerating) {
                this.previousResult = { ...this.currentResult };
                this.updatePreviousResultThumb();
              }

              if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
                URL.revokeObjectURL(this.previewUrl);
              }

              this.previewUrl = blobUrl;
              this.isPreviewGenerating = true;

              this.elements.previewVideo.style.display = 'none';
              this.elements.previewVideoInfo.classList.remove('visible');
              
              this.elements.previewPlaceholder.style.display = 'none';
              this.elements.previewImage.src = this.previewUrl;
              this.elements.previewImage.style.display = 'block';
              // 不在生成过程中更新背景图
              this.resetPreviewZoom();
            }
          }
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Binary message error:', e);
      }
    }

    clearPreviewFrames() {
      // 释放之前帧的 blob URL
      this.previewFrames.forEach(url => {
        if (url && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
      this.previewFrames = [];
      this.currentFrameIndex = 0;
    }

    startFrameAnimation() {
      if (this.previewFrames.length < 2) {
        // console.log('[ComfyUI Panel] Not enough frames for animation');
        return;
      }
      
      // 使用实际帧率，或者压缩到3秒播放
      let fps = this.videoRate || 16;
      // 如果帧数太多，压缩到3秒播放
      if (this.previewFrames.length > fps * 3) {
        fps = this.previewFrames.length / 3;
      }
      if (fps < 5) fps = 5;
      else if (fps > 30) fps = 30;
      
      this.framePlaybackRate = Math.round(1000 / fps);
      
      // console.log('[ComfyUI Panel] Starting frame animation, frames:', this.previewFrames.length, 'fps:', fps, 'interval:', this.framePlaybackRate, 'ms');
      
      // 更新帧信息显示
      this.elements.videoFrameInfo.textContent = `预览: ${this.previewFrames.length}帧 @ ${Math.round(fps)}fps`;
      this.elements.previewVideoInfo.classList.add('visible');
      
      // 重置帧索引并开始播放
      this.currentFrameIndex = 0;
      
      // 先停止之前的动画（如果有的话）
      if (this.frameAnimationId) {
        clearTimeout(this.frameAnimationId);
      }
      
      // 立即显示第一帧
      this.elements.previewImage.src = this.previewFrames[0];
      this.elements.previewImage.style.display = 'block';
      this.elements.previewVideo.style.display = 'none';
      this.elements.previewPlaceholder.style.display = 'none';
      // 不在生成过程中更新背景图
      
      // 开始循环播放
      this._scheduleNextFrame();
    }
    
    _scheduleNextFrame() {
      const self = this;
      this.frameAnimationId = setTimeout(function() {
        self._playNextFrame();
      }, this.framePlaybackRate);
    }

    _playNextFrame() {
      if (this.previewFrames.length === 0) {
        // console.log('[ComfyUI Panel] No frames to play');
        this.frameAnimationId = null;
        return;
      }
      
      // 更新帧索引（循环）
      this.currentFrameIndex = (this.currentFrameIndex + 1) % this.previewFrames.length;
      
      // 显示当前帧
      const frameUrl = this.previewFrames[this.currentFrameIndex];
      this.elements.previewImage.src = frameUrl;
      this.elements.previewImage.style.display = 'block';
      this.elements.previewVideo.style.display = 'none';
      this.elements.previewPlaceholder.style.display = 'none';
      
      // 每隔10帧输出一次日志
      // if (this.currentFrameIndex % 10 === 0) {
      //   console.log('[ComfyUI Panel] Playing frame:', this.currentFrameIndex, '/', this.previewFrames.length);
      // }
      
      // 继续播放下一帧
      this._scheduleNextFrame();
    }

    stopFrameAnimation() {
      if (this.frameAnimationId) {
        clearTimeout(this.frameAnimationId);
        this.frameAnimationId = null;
        // console.log('[ComfyUI Panel] Frame animation stopped');
      }
    }
    
    // 手动测试帧动画（供调试使用）
    testFrameAnimation() {
      // console.log('[ComfyUI Panel] Manual test - frames:', this.previewFrames.length, 'animationId:', this.frameAnimationId);
      if (this.previewFrames.length > 0) {
        this.startFrameAnimation();
      } else {
        // console.log('[ComfyUI Panel] No frames available for test');
      }
    }

    show() {
      // 重新检测运行环境（因为 app 可能是异步初始化的）
      const isExplicitStandalone = window.COMFYUI_PANEL_STANDALONE === true;
      const appAvailable = typeof app !== 'undefined' && app.api;
      
      // 更新运行模式标志（只有在非显式独立模式下才更新）
      if (!isExplicitStandalone && appAvailable) {
        this.isStandaloneMode = false;
        this.isConnected = true;
        this.connectionStatus = 'connected';
      } else if (isExplicitStandalone) {
        // 显式独立模式，确保标志正确
        this.isStandaloneMode = true;
      }
      
      // ComfyUI 嵌入模式：更新 baseUrl
      if (!this.isStandaloneMode && appAvailable && app.api.api_base) {
        this.baseUrl = app.api.api_base.replace(/\/+$/, '');
      }
      
      // 独立模式：检查是否已连接（使用显式标志）
      if (isExplicitStandalone || this.isStandaloneMode) {
        const connectionPanel = document.getElementById('connection-panel');
        if (!this.isConnected && connectionPanel) {
          // 未连接时显示连接面板
          connectionPanel.classList.add('visible');
        } else if (connectionPanel) {
          // 已连接时隐藏连接面板
          connectionPanel.classList.remove('visible');
        }
      }
      
      // 首次点击时加载服务器配置
      if (!this.configLoaded) {
        this.configLoaded = true;
        this.loadConfig();
      }
      
      this.panel.classList.add('visible');
      this.openBtn.style.display = 'none';
      this.panelVisible = true;
      this.elements.previewPanel.style.width = '66.67%';
      if (this.elements.workflowSource && this.elements.workflowSource.value === 'canvas') this.loadCanvasWorkflow();

      // 检测是否存在之前的生成结果，如果存在就加载为背景图
      if (this.currentResult && this.currentResult.url) {
        this.updatePreviewBackground(this.currentResult.url);
      } else if (this.previousResult && this.previousResult.url) {
        this.updatePreviewBackground(this.previousResult.url);
      }
    }

    hide() {
      this.panel.classList.remove('visible');
      this.openBtn.style.display = 'block';
      this.panelVisible = false;
      
      // 关闭面板时重置右侧面板状态
      if (this.rightPanelHidden) {
        this.toggleRightPanel();
      }
    }

    // 切换右侧面板显示/隐藏（Tab键触发）
    toggleRightPanel() {
      const previewPanel = this.elements.previewPanel;
      const resizer = this.elements.resizer;
      const panelConfig = this.elements.panelConfig;
      
      if (this.rightPanelHidden) {
        // 恢复右侧面板
        previewPanel.style.width = this.savedPreviewWidth;
        resizer.style.display = '';
        panelConfig.style.display = '';
        this.rightPanelHidden = false;
        // 恢复上一个结果图标大小 - 移除全屏模式类
        this.elements.previousResultThumb.classList.remove('fullscreen-mode');
        // 将图像卡片移动回原来的位置
        this.restoreImageCards();
        // 隐藏圆形进度指示器
        this.hideCircularProgress();
        // 隐藏浮动面板
        this.elements.imageCardFloatPanel.classList.remove('visible');
      } else {
        // 隐藏右侧面板
        this.savedPreviewWidth = previewPanel.style.width || '66.67%';
        previewPanel.style.width = '100%';
        resizer.style.display = 'none';
        panelConfig.style.display = 'none';
        this.rightPanelHidden = true;
        // 缩小上一个结果图标 - 添加全屏模式类（允许正确展开）
        this.elements.previousResultThumb.classList.add('fullscreen-mode');
        // 创建图像卡片浮动图标
        this.createImageCardFloatIcons();
        // 显示圆形进度指示器
        this.showCircularProgress();
      }
    }

    // 获取所有标签页中的图像加载卡片ID（去重）
    getAllImageCardIds() {
      const allNodeIds = new Set();
      
      // 遍历所有标签页收集节点ID
      this.tabs.forEach(tab => {
        if (tab.nodeIds) {
          tab.nodeIds.forEach(id => allNodeIds.add(id));
        }
      });
      
      // 过滤出图像加载节点
      const imageNodeIds = [];
      allNodeIds.forEach(nodeId => {
        const node = this.parsedNodes.find(n => n.id === nodeId);
        if (node && node.isImageNode && node.inputs.length > 0) {
          imageNodeIds.push(nodeId);
        }
      });
      
      return imageNodeIds;
    }

    // 创建图像卡片浮动图标
    createImageCardFloatIcons() {
      const imageNodeIds = this.getAllImageCardIds();
      const previewContent = document.querySelector('.preview-content');
      
      // 清除之前创建的浮动图标
      document.querySelectorAll('.image-card-float-icon').forEach(el => el.remove());
      
      // 存储原始卡片位置信息
      this.imageCardOriginalPositions = {};
      
      // 初始化自动隐藏定时器
      this.floatPanelHideTimer = null;
      this.currentFloatPanelNodeId = null;
      
      imageNodeIds.forEach((nodeId, index) => {
        const cardEl = this.elements.configCards.querySelector(`.config-card[data-node-id="${nodeId}"]`);
        if (!cardEl) return;
        
        const node = this.parsedNodes.find(n => n.id === nodeId);
        if (!node) return;
        
        // 创建浮动图标
        const icon = document.createElement('div');
        icon.className = 'image-card-float-icon';
        icon.dataset.nodeId = nodeId;
        icon.style.top = (55 + index * 50) + 'px';
        
        // 获取卡片中的图片预览
        const cardImg = cardEl.querySelector('.image-preview');
        if (cardImg && cardImg.src) {
          const iconImg = document.createElement('img');
          iconImg.className = 'icon-img';
          iconImg.src = cardImg.src;
          icon.appendChild(iconImg);
        } else {
          // 没有图片时显示默认图标
          const defaultIcon = document.createElement('span');
          defaultIcon.style.cssText = 'font-size: 20px;';
          defaultIcon.textContent = '🖼️';
          icon.appendChild(defaultIcon);
        }
        
        // 添加标签
        const label = document.createElement('span');
        label.className = 'icon-label';
        label.textContent = node.title;
        icon.appendChild(label);
        
        // 存储原始位置
        this.imageCardOriginalPositions[nodeId] = {
          parent: cardEl.parentElement,
          nextSibling: cardEl.nextSibling
        };
        
        // 鼠标移入显示浮动面板
        icon.addEventListener('mouseenter', () => {
          this.showImageCardFloatPanel(nodeId);
        });
        
        previewContent.appendChild(icon);
      });
      
      // 为浮动面板添加鼠标事件
      this.elements.imageCardFloatPanel.addEventListener('mouseenter', () => {
        // 鼠标进入浮动面板，取消隐藏定时器
        if (this.floatPanelHideTimer) {
          clearTimeout(this.floatPanelHideTimer);
          this.floatPanelHideTimer = null;
        }
      });
      
      this.elements.imageCardFloatPanel.addEventListener('mouseleave', () => {
        // 鼠标离开浮动面板，0.5秒后隐藏（如果未钉住）
        this.startFloatPanelHideTimer();
      });
      
      // 图钉按钮事件
      this.floatPanelPinned = false;
      this.elements.floatPanelPin.onclick = (e) => {
        e.stopPropagation();
        this.floatPanelPinned = !this.floatPanelPinned;
        this.elements.floatPanelPin.classList.toggle('pinned', this.floatPanelPinned);
        if (this.floatPanelPinned) {
          // 钉住时取消隐藏定时器
          if (this.floatPanelHideTimer) {
            clearTimeout(this.floatPanelHideTimer);
            this.floatPanelHideTimer = null;
          }
        }
      };
    }

    // 显示图像卡片浮动面板
    showImageCardFloatPanel(nodeId) {
      const node = this.parsedNodes.find(n => n.id === nodeId);
      if (!node) return;
      
      // 取消之前的隐藏定时器
      if (this.floatPanelHideTimer) {
        clearTimeout(this.floatPanelHideTimer);
        this.floatPanelHideTimer = null;
      }
      
      // 如果当前显示的是其他卡片，先将其移回
      if (this.currentFloatPanelNodeId && this.currentFloatPanelNodeId !== nodeId) {
        this.restoreCardToOriginalPosition(this.currentFloatPanelNodeId);
      }
      
      // 更新标题
      this.elements.floatPanelTitle.textContent = node.title;
      
      // 如果当前没有显示卡片或显示的是不同的卡片
      if (this.currentFloatPanelNodeId !== nodeId) {
        // 清空浮动面板内容
        this.elements.floatPanelBody.innerHTML = '';
        
        // 获取原始卡片
        const cardEl = this.elements.configCards.querySelector(`.config-card[data-node-id="${nodeId}"]`);
        if (cardEl) {
          // 移动卡片到浮动面板
          this.elements.floatPanelBody.appendChild(cardEl);
        }
        
        this.currentFloatPanelNodeId = nodeId;
      }
      
      // 显示浮动面板
      this.elements.imageCardFloatPanel.classList.add('visible');
    }
    
    // 开始浮动面板隐藏定时器
    startFloatPanelHideTimer() {
      // 如果已钉住，不启动隐藏定时器
      if (this.floatPanelPinned) return;
      
      if (this.floatPanelHideTimer) {
        clearTimeout(this.floatPanelHideTimer);
      }
      this.floatPanelHideTimer = setTimeout(() => {
        this.hideImageCardFloatPanel();
      }, 500);
    }

    // 隐藏图像卡片浮动面板
    hideImageCardFloatPanel() {
      // 如果已钉住，不隐藏
      if (this.floatPanelPinned) return;
      
      if (this.currentFloatPanelNodeId) {
        this.restoreCardToOriginalPosition(this.currentFloatPanelNodeId);
        this.currentFloatPanelNodeId = null;
      }
      
      // 隐藏浮动面板
      this.elements.imageCardFloatPanel.classList.remove('visible');
    }
    
    // 将卡片恢复到原始位置
    restoreCardToOriginalPosition(nodeId) {
      const cardEl = this.elements.floatPanelBody.querySelector(`.config-card[data-node-id="${nodeId}"]`);
      if (cardEl && this.imageCardOriginalPositions && this.imageCardOriginalPositions[nodeId]) {
        const pos = this.imageCardOriginalPositions[nodeId];
        if (pos.nextSibling) {
          pos.parent.insertBefore(cardEl, pos.nextSibling);
        } else {
          pos.parent.appendChild(cardEl);
        }
      } else if (cardEl) {
        // 如果没有存储位置，直接添加回 configCards
        this.elements.configCards.appendChild(cardEl);
      }
    }

    // 恢复所有图像卡片到原来的位置
    restoreImageCards() {
      if (!this.imageCardOriginalPositions) return;
      
      // 先处理浮动面板中的卡片
      const floatPanelCards = this.elements.floatPanelBody.querySelectorAll('.config-card');
      floatPanelCards.forEach(cardEl => {
        const nodeId = cardEl.dataset.nodeId;
        const pos = this.imageCardOriginalPositions[nodeId];
        if (pos) {
          if (pos.nextSibling) {
            pos.parent.insertBefore(cardEl, pos.nextSibling);
          } else {
            pos.parent.appendChild(cardEl);
          }
        } else {
          this.elements.configCards.appendChild(cardEl);
        }
      });
      
      // 清除浮动图标
      document.querySelectorAll('.image-card-float-icon').forEach(el => el.remove());
      
      // 清除位置记录
      this.imageCardOriginalPositions = null;
    }

    // 显示圆形进度指示器
    showCircularProgress() {
      this.elements.circularProgress.classList.add('visible');
      this.updateCircularProgress(this.lastProgress.current, this.lastProgress.total);
    }

    // 隐藏圆形进度指示器
    hideCircularProgress() {
      this.elements.circularProgress.classList.remove('visible');
    }

    // 更新圆形进度指示器
    updateCircularProgress(current, total) {
      const progress = total > 0 ? (current / total) : 0;
      const circumference = 2 * Math.PI * 25; // r=25
      const offset = circumference * (1 - progress);
      
      const progressFill = this.elements.circularProgress.querySelector('.progress-fill');
      if (progressFill) {
        progressFill.style.strokeDashoffset = offset;
      }
      
      if (this.elements.circularProgressText) {
        this.elements.circularProgressText.textContent = Math.round(progress * 100) + '%';
      }
    }

    loadUploadedWorkflow(event) {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try { 
          const workflow = JSON.parse(e.target.result); 
          this.setWorkflow(workflow);
          this.resetTabsFromWorkflow();
          // 清除服务器配置列表选项，避免点保存覆盖原配置
          this.elements.serverConfigSelect.value = '';
        }
        catch (err) { alert('无法解析工作流文件'); }
      };
      reader.readAsText(file);
    }

    resetTabsFromWorkflow() {
      this.tabs = [];
      this.tabNodes = {};
      this.addTab('常用', 'main');
      const mainTab = this.tabs[0];
      // 设置 nodeIds，并确保所有引用指向同一个数组
      const imageNodeIds = this.parsedNodes.filter(n => n.isImageNode && n.inputs.length > 0).map(n => n.id);
      mainTab.nodeIds = imageNodeIds;
      this.tabNodes[mainTab.id] = mainTab.nodeIds;
      this.activeCards = mainTab.nodeIds;
      this.renderTabs();
      this.switchTab(mainTab.id);
      this.renderSettingsNodes();
    }

    setWorkflow(workflow) {
      this.workflow = workflow;
      this.parsedNodes = [];
      this.cardValues = {};
      this.outputNodeIds = new Set();
      // 保存原始工作流的输入连接信息（用于重置功能）
      this.originalInputLinks = {};
      // 重置用户配置的上游连接设置，避免旧工作流的配置影响新工作流
      this.inputLinkSettings = {};
      this.cardLinkToggleState = {};
      this.inputDefaultConfig = {};
      this.inputDisabledValues = {};
      // 创建节点ID到节点标题的映射（用于显示上游节点名称）
      this.nodeIdToTitle = {};
      
      // 先创建节点ID到标题的映射
      for (const [nodeId, node] of Object.entries(workflow)) {
        this.nodeIdToTitle[nodeId] = getNodeTitle(node, nodeId);
      }

      for (const [nodeId, node] of Object.entries(workflow)) {
        const classType = node.class_type;
        if (CONFIG.DISPLAY_OUTPUT_TYPES.includes(classType)) this.outputNodeIds.add(nodeId);

        const inputs = [];
        for (const [inputKey, inputValue] of Object.entries(node.inputs || {})) {
          // 检查是否是上游节点连接（数组格式：["nodeId", outputIndex]）
          const isLink = Array.isArray(inputValue) && inputValue.length === 2 && typeof inputValue[0] === 'string';
          
          // 保存原始连接信息
          if (isLink) {
            if (!this.originalInputLinks[nodeId]) {
              this.originalInputLinks[nodeId] = {};
            }
            this.originalInputLinks[nodeId][inputKey] = {
              linkNodeId: inputValue[0],
              linkOutputIndex: inputValue[1]
            };
          }
          
          // 规范化值：处理 __value__ 格式的错误数据
          const normalizedValue = isLink ? '' : normalizeValue(inputValue);
          const widgetType = isLink ? 'link' : inferWidgetType(inputKey, normalizedValue, classType);
          if (widgetType === 'hidden') continue;
          
          inputs.push({ 
            key: inputKey, 
            value: normalizedValue, 
            widgetType: widgetType, 
            label: formatLabel(inputKey),
            // 上游连接信息
            hasLink: isLink,
            linkNodeId: isLink ? inputValue[0] : '',
            linkOutputIndex: isLink ? inputValue[1] : 0
          });
          
          if (!isLink) {
            this.cardValues[nodeId + '.' + inputKey] = normalizedValue;
          }
        }

        this.parsedNodes.push({
          id: nodeId, classType: classType, title: getNodeTitle(node, nodeId),
          isImageNode: classType === 'LoadImage',
          isSeedNode: classType === 'PrimitiveInt' || classType === 'PrimitiveFloat',
          isOutputNode: CONFIG.DISPLAY_OUTPUT_TYPES.includes(classType),
          inputs: inputs,
        });
      }

      this.updateSeedNodeSelect();
    }

    updateSeedNodeSelect() {
      const select = this.elements.seedNodeSelect;
      select.innerHTML = '<option value="">选择节点...</option>';
      for (const node of this.parsedNodes) {
        if (node.classType === 'RandomSeedNode' ||
          node.isSeedNode ||
          node.classType.includes('Seed')) {
          const option = document.createElement('option');
          option.value = node.id;
          option.textContent = node.title;
          if (this.seedNode === node.id) option.selected = true;
          select.appendChild(option);
        }
      }
    }

    renderConfigCards() {
      const oldImageData = {};
      for (const [key, data] of Object.entries(this.imageCropData)) {
        const imgData = data.getData ? data.getData() : null;
        if (imgData && imgData.filename) {
          oldImageData[key] = {
            filename: imgData.filename,
            cropX: imgData.cropX,
            cropY: imgData.cropY,
            cropW: imgData.cropW,
            cropH: imgData.cropH,
            width: imgData.width,
            height: imgData.height
          };
        } else if (this.cardValues[key]) {
          oldImageData[key] = { filename: this.cardValues[key] };
        }
      }

      const container = this.elements.configCards;
      container.innerHTML = '';
      this.imageCropData = {};

      // 创建节点ID到节点的映射，用于快速查找
      const nodeMap = new Map(this.parsedNodes.map(n => [n.id, n]));

      // 按 activeCards 的顺序渲染卡片，确保顺序与保存时一致
      for (const nodeId of this.activeCards) {
        const node = nodeMap.get(nodeId);
        if (!node || node.inputs.length === 0) continue;
        container.appendChild(this.createConfigCard(node));
      }

      for (const [key, saved] of Object.entries(oldImageData)) {
        if (this.imageCropData[key] && this.imageCropData[key].restore) {
          this.imageCropData[key].restore(saved.filename, saved);
          // 恢复时，认为图片是已上传状态，无需再次上传
          if (this.imageCropData[key]) {
            this.imageCropData[key].needsUpload = false;
          }
        }
      }
    }

    createConfigCard(node) {
      const card = document.createElement('div');
      card.className = 'config-card';
      card.dataset.nodeId = node.id;
      // 注意：不在整个卡片上设置 draggable，而是在标题栏上设置
      
      // 检查节点是否有任何上游连接
      const hasAnyLink = node.inputs.some(input => {
        const key = node.id + '.' + input.key;
        const hasOriginalLink = this.originalInputLinks[node.id] && this.originalInputLinks[node.id][input.key];
        const savedSettings = this.inputLinkSettings[key];
        return hasOriginalLink || (savedSettings && savedSettings.enabled && savedSettings.linkNodeId);
      });

      const header = document.createElement('div');
      header.className = 'config-card-header';
      // 只有折叠状态下标题栏才可拖拽排序，展开状态下标题栏触发拖拽滑动
      header.draggable = card.classList.contains('collapsed');
      header.innerHTML = `
        <span class="config-card-toggle">▼</span>
        <span class="config-card-title">[${node.id}] ${node.title}</span>
        <div class="config-card-actions">
          <button class="panel-btn panel-btn-secondary panel-btn-icon move-top-btn" title="移动到顶端">⏫</button>
          <button class="panel-btn panel-btn-secondary panel-btn-icon move-up-btn" title="上移">↑</button>
          <button class="panel-btn panel-btn-secondary panel-btn-icon move-down-btn" title="下移">↓</button>
          <button class="panel-btn panel-btn-secondary panel-btn-icon move-bottom-btn" title="移动到底端">⏬</button>
          <button class="panel-btn panel-btn-secondary panel-btn-icon remove-card-btn">-</button>
        </div>
      `;

      header.querySelector('.move-up-btn').onclick = (e) => {
        e.stopPropagation();
        this.moveCardUp(node.id);
      };
      header.querySelector('.move-down-btn').onclick = (e) => {
        e.stopPropagation();
        this.moveCardDown(node.id);
      };
      header.querySelector('.move-top-btn').onclick = (e) => {
        e.stopPropagation();
        this.moveCardToTop(node.id);
      };
      header.querySelector('.move-bottom-btn').onclick = (e) => {
        e.stopPropagation();
        this.moveCardToBottom(node.id);
      };
      header.querySelector('.config-card-toggle').onclick = (e) => {
        e.stopPropagation();
        const isNowCollapsed = card.classList.toggle('collapsed');
        // 更新标题栏的draggable属性：折叠时可拖拽排序，展开时不可拖拽排序
        header.draggable = isNowCollapsed;
      };
      header.querySelector('.remove-card-btn').onclick = (e) => {
        e.stopPropagation();
        this.removeCard(node.id);
      };

      header.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const isNowCollapsed = card.classList.toggle('collapsed');
        // 更新标题栏的draggable属性：折叠时可拖拽排序，展开时不可拖拽排序
        header.draggable = isNowCollapsed;
      });

      const body = document.createElement('div');
      body.className = 'config-card-body';
      for (const input of node.inputs) body.appendChild(this.createFormGroup(node, input, card));

      card.appendChild(header);
      card.appendChild(body);

      this.bindCardDragEvents(card);

      return card;
    }

    moveCardUp(nodeId) {
      const index = this.activeCards.indexOf(nodeId);
      if (index <= 0) return;
      [this.activeCards[index - 1], this.activeCards[index]] = [this.activeCards[index], this.activeCards[index - 1]];
      this.updateCardsOrder();
    }

    moveCardDown(nodeId) {
      const index = this.activeCards.indexOf(nodeId);
      if (index === -1 || index === this.activeCards.length - 1) return;
      [this.activeCards[index], this.activeCards[index + 1]] = [this.activeCards[index + 1], this.activeCards[index]];
      this.updateCardsOrder();
    }

    moveCardToTop(nodeId) {
      const index = this.activeCards.indexOf(nodeId);
      if (index <= 0) return;
      this.activeCards.splice(index, 1);
      this.activeCards.unshift(nodeId);
      this.updateCardsOrder();
    }

    moveCardToBottom(nodeId) {
      const index = this.activeCards.indexOf(nodeId);
      if (index === -1 || index === this.activeCards.length - 1) return;
      this.activeCards.splice(index, 1);
      this.activeCards.push(nodeId);
      this.updateCardsOrder();
    }

    updateCardsOrder() {
      const container = this.elements.configCards;
      const cards = Array.from(container.children);
      const idToCard = new Map(cards.map(card => [card.dataset.nodeId, card]));

      this.activeCards.forEach(nodeId => {
        const card = idToCard.get(nodeId);
        if (card) container.appendChild(card);
      });
      
      // 由于 activeCards 和 currentTab.nodeIds 是同一个引用，不需要额外同步
    }

    bindCardDragEvents(card) {
      let dragTargetId = null;
      let dropPosition = null;
      const header = card.querySelector('.config-card-header');

      // 拖拽开始和结束事件绑定到标题栏（header 是 draggable 元素）
      if (header) {
        header.addEventListener('dragstart', (e) => {
          dragTargetId = card.dataset.nodeId;
          card.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', dragTargetId);
          const img = new Image();
          img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
          e.dataTransfer.setDragImage(img, 0, 0);
          setTimeout(() => card.style.opacity = '0.5', 0);
        });

        header.addEventListener('dragend', (e) => {
          card.classList.remove('dragging');
          card.style.opacity = '';
          document.querySelectorAll('.config-card.drop-before, .config-card.drop-after').forEach(el => {
            el.classList.remove('drop-before', 'drop-after');
          });
          dragTargetId = null;
          dropPosition = null;
        });
      }

      // 拖放目标事件绑定到卡片
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';

        const draggingCard = document.querySelector('.config-card.dragging');
        if (!draggingCard || draggingCard === card) return;

        const rect = card.getBoundingClientRect();
        const mouseY = e.clientY;
        const threshold = rect.top + rect.height / 2;

        document.querySelectorAll('.config-card.drop-before, .config-card.drop-after').forEach(el => {
          el.classList.remove('drop-before', 'drop-after');
        });

        if (mouseY < threshold) {
          card.classList.add('drop-before');
          dropPosition = 'before';
        } else {
          card.classList.add('drop-after');
          dropPosition = 'after';
        }
      });

      card.addEventListener('dragleave', (e) => {
        if (!card.contains(e.relatedTarget)) {
          card.classList.remove('drop-before', 'drop-after');
        }
      });

      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drop-before', 'drop-after');

        const draggedNodeId = e.dataTransfer.getData('text/plain');
        const targetNodeId = card.dataset.nodeId;

        if (!draggedNodeId || draggedNodeId === targetNodeId) return;

        if (dropPosition === 'before') {
          this.reorderCardsBefore(draggedNodeId, targetNodeId);
        } else if (dropPosition === 'after') {
          this.reorderCardsAfter(draggedNodeId, targetNodeId);
        }
      });
    }

    reorderCardsBefore(draggedNodeId, targetNodeId) {
      const draggedIndex = this.activeCards.indexOf(draggedNodeId);
      const targetIndex = this.activeCards.indexOf(targetNodeId);
      if (draggedIndex === -1 || targetIndex === -1) return;

      this.activeCards.splice(draggedIndex, 1);
      const newTargetIndex = this.activeCards.indexOf(targetNodeId);
      this.activeCards.splice(newTargetIndex, 0, draggedNodeId);

      const container = this.elements.configCards;
      const draggedCard = container.querySelector(`.config-card[data-node-id="${draggedNodeId}"]`);
      const targetCard = container.querySelector(`.config-card[data-node-id="${targetNodeId}"]`);
      if (draggedCard && targetCard) {
        targetCard.parentNode.insertBefore(draggedCard, targetCard);
      }
      
      // 由于 activeCards 和 currentTab.nodeIds 是同一个引用，不需要额外同步
    }

    reorderCardsAfter(draggedNodeId, targetNodeId) {
      const draggedIndex = this.activeCards.indexOf(draggedNodeId);
      const targetIndex = this.activeCards.indexOf(targetNodeId);
      if (draggedIndex === -1 || targetIndex === -1) return;

      this.activeCards.splice(draggedIndex, 1);
      const newTargetIndex = this.activeCards.indexOf(targetNodeId);
      this.activeCards.splice(newTargetIndex + 1, 0, draggedNodeId);

      const container = this.elements.configCards;
      const draggedCard = container.querySelector(`.config-card[data-node-id="${draggedNodeId}"]`);
      const targetCard = container.querySelector(`.config-card[data-node-id="${targetNodeId}"]`);
      if (draggedCard && targetCard) {
        targetCard.parentNode.insertBefore(draggedCard, targetCard.nextSibling);
      }
      
      // 由于 activeCards 和 currentTab.nodeIds 是同一个引用，不需要额外同步
    }

    createFormGroup(node, input, card) {
      const group = document.createElement('div');
      group.className = 'form-group';
      group.dataset.inputKey = input.key;
      
      // 检查是否有原始上游连接
      const hasOriginalLink = this.originalInputLinks[node.id] && this.originalInputLinks[node.id][input.key];
      const key = node.id + '.' + input.key;
      
      // 如果有上游连接，显示特殊的上游连接控件
      if (hasOriginalLink) {
        const upstreamControl = this.createUpstreamLinkControl(node, input, key, hasOriginalLink);
        group.appendChild(upstreamControl);
      } else {
        // 没有上游连接，显示正常的输入控件
        // 判断是否使用行内布局（数值类型使用行内布局）
        const isInlineType = ['number', 'boolean', 'combo'].includes(input.widgetType);
        if (isInlineType) {
          group.classList.add('inline-layout');
        }
        
        // 创建标签
        if (input.widgetType !== 'image' && input.widgetType !== 'link') {
          const label = document.createElement('label');
          label.className = 'form-label';
          label.textContent = input.label;
          group.appendChild(label);
        }
        if (input.widgetType !== 'link') {
          group.appendChild(this.createFormInput(node, input));
        }
      }
      
      return group;
    }
    
    // 创建上游连接控件（只给有上游连接的项目显示）
    createUpstreamLinkControl(node, input, key, originalLink) {
      const container = document.createElement('div');
      container.className = 'upstream-link-row';
      container.dataset.key = key;
      
      // 获取节点类型
      const nodeClassType = this.workflow[node.id]?.class_type || '';
      
      // 获取保存的设置
      const savedSettings = this.inputLinkSettings[key] || {
        enabled: true,
        linkNodeId: originalLink.linkNodeId,
        linkOutputIndex: originalLink.linkOutputIndex
      };
      
      // 获取禁用时的替代值设置
      const savedDisabledValue = this.inputDisabledValues[key] || {};
      
      // 是否启用
      const isEnabled = savedSettings.enabled !== false;
      
      // 获取输入项的数据类型（从字典中查找）
      let dataType = null;
      if (this.nodeTypeInputTypes[nodeClassType] && this.nodeTypeInputTypes[nodeClassType][input.key]) {
        dataType = this.nodeTypeInputTypes[nodeClassType][input.key];
      }
      
      // 启用按钮
      const enableBtn = document.createElement('button');
      enableBtn.type = 'button';
      enableBtn.className = 'link-enable-btn' + (isEnabled ? ' enabled' : '');
      enableBtn.textContent = '🔗';
      enableBtn.title = isEnabled ? '点击禁用连接' : '点击启用连接';
      
      // 输入项名称
      const nameLabel = document.createElement('span');
      nameLabel.className = 'link-name-label';
      nameLabel.textContent = input.label + ':';
      
      // 右侧控件组 - 连接设置（启用时显示）
      const linkGroup = document.createElement('div');
      linkGroup.className = 'link-right-group';
      linkGroup.style.display = isEnabled ? '' : 'none';
      
      // 上游节点名称显示
      const upstreamName = document.createElement('span');
      upstreamName.className = 'link-upstream-name';
      upstreamName.textContent = savedSettings.linkNodeId ? (this.nodeIdToTitle[savedSettings.linkNodeId] || '') : '';
      
      // ID标签
      const idLabel = document.createElement('span');
      idLabel.className = 'link-label';
      idLabel.textContent = 'ID:';
      
      // ID输入框
      const idInput = document.createElement('input');
      idInput.type = 'text';
      idInput.className = 'link-id-input';
      idInput.placeholder = 'ID';
      idInput.value = savedSettings.linkNodeId || '';
      
      // out标签
      const outLabel = document.createElement('span');
      outLabel.className = 'link-label';
      outLabel.textContent = 'out:';
      
      // out输入框
      const outInput = document.createElement('input');
      outInput.type = 'number';
      outInput.className = 'link-out-input';
      outInput.placeholder = 'out';
      outInput.value = savedSettings.linkOutputIndex || 0;
      outInput.min = 0;
      
      // 重置按钮
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'link-reset-btn';
      resetBtn.textContent = '↺';
      resetBtn.title = '重置为原始连接并启用';
      
      // 禁用时的值输入控件组
      const valueGroup = document.createElement('div');
      valueGroup.className = 'link-value-container';
      valueGroup.style.display = isEnabled ? 'none' : '';
      
      // 创建值输入控件的函数
      const createValueInput = (type, initialValue) => {
        valueGroup.innerHTML = '';
        
        if (type === 'int') {
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'link-value-input';
          input.step = '1';
          input.value = initialValue !== undefined ? initialValue : 0;
          input.oninput = () => {
            this.inputDisabledValues[key] = { dataType: 'int', value: parseInt(input.value) || 0 };
          };
          valueGroup.appendChild(input);
        } else if (type === 'float') {
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'link-value-input';
          input.step = '0.01';
          input.value = initialValue !== undefined ? initialValue : 0;
          input.oninput = () => {
            this.inputDisabledValues[key] = { dataType: 'float', value: parseFloat(input.value) || 0 };
          };
          valueGroup.appendChild(input);
        } else if (type === 'string') {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'link-value-input';
          input.style.width = '100px';
          input.value = initialValue !== undefined ? initialValue : '';
          input.oninput = () => {
            this.inputDisabledValues[key] = { dataType: 'string', value: input.value };
          };
          valueGroup.appendChild(input);
        } else if (type === 'boolean') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'link-value-btn ' + (initialValue === true ? 'true' : 'false');
          btn.textContent = initialValue === true ? '真' : '假';
          btn.onclick = () => {
            const newVal = btn.classList.contains('true') ? false : true;
            btn.classList.remove('true', 'false');
            btn.classList.add(newVal ? 'true' : 'false');
            btn.textContent = newVal ? '真' : '假';
            this.inputDisabledValues[key] = { dataType: 'boolean', value: newVal };
          };
          valueGroup.appendChild(btn);
        }
      };
      
      // 创建数据类型选择下拉列表（当字典中没有时使用）
      const createDataTypeSelect = () => {
        valueGroup.innerHTML = '';
        
        const select = document.createElement('select');
        select.className = 'link-value-input';
        select.style.width = '60px';
        select.innerHTML = `
          <option value="">空</option>
          <option value="int">整数</option>
          <option value="float">浮点</option>
          <option value="string">文本</option>
          <option value="boolean">布尔</option>
        `;
        
        const valueSpan = document.createElement('span');
        valueSpan.style.marginLeft = '4px';
        
        select.onchange = () => {
          const newType = select.value;
          valueSpan.innerHTML = '';
          
          if (newType) {
            // 创建值输入控件，但不隐藏下拉列表
            const savedValue = this.inputDisabledValues[key]?.value;
            createValueInputInSpan(newType, savedValue, valueSpan);
          }
          
          if (newType) {
            this.inputDisabledValues[key] = { dataType: newType, value: undefined };
          } else {
            this.inputDisabledValues[key] = { dataType: 'null', value: null };
          }
        };
        
        valueGroup.appendChild(select);
        valueGroup.appendChild(valueSpan);
      };
      
      // 在指定容器中创建值输入控件
      const createValueInputInSpan = (type, initialValue, container) => {
        container.innerHTML = '';
        
        if (type === 'int') {
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'link-value-input';
          input.step = '1';
          input.value = initialValue !== undefined ? initialValue : 0;
          input.oninput = () => {
            this.inputDisabledValues[key] = { dataType: 'int', value: parseInt(input.value) || 0 };
          };
          container.appendChild(input);
        } else if (type === 'float') {
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'link-value-input';
          input.step = '0.01';
          input.value = initialValue !== undefined ? initialValue : 0;
          input.oninput = () => {
            this.inputDisabledValues[key] = { dataType: 'float', value: parseFloat(input.value) || 0 };
          };
          container.appendChild(input);
        } else if (type === 'string') {
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'link-value-input';
          input.style.width = '80px';
          input.value = initialValue !== undefined ? initialValue : '';
          input.oninput = () => {
            this.inputDisabledValues[key] = { dataType: 'string', value: input.value };
          };
          container.appendChild(input);
        } else if (type === 'boolean') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'link-value-btn ' + (initialValue === true ? 'true' : 'false');
          btn.textContent = initialValue === true ? '真' : '假';
          btn.onclick = () => {
            const newVal = btn.classList.contains('true') ? false : true;
            btn.classList.remove('true', 'false');
            btn.classList.add(newVal ? 'true' : 'false');
            btn.textContent = newVal ? '真' : '假';
            this.inputDisabledValues[key] = { dataType: 'boolean', value: newVal };
          };
          container.appendChild(btn);
        }
      };
      
      // 初始化禁用时的值输入控件
      if (!isEnabled) {
        if (dataType) {
          // 有已知的数据类型
          createValueInput(dataType, savedDisabledValue.value);
        } else {
          // 没有已知的数据类型，显示下拉选择
          createDataTypeSelect();
          // 如果有保存的类型，恢复
          if (savedDisabledValue.dataType && savedDisabledValue.dataType !== 'null') {
            const select = valueGroup.querySelector('select');
            if (select) {
              select.value = savedDisabledValue.dataType;
              createValueInputInSpan(savedDisabledValue.dataType, savedDisabledValue.value, valueGroup.querySelector('span'));
            }
          }
        }
      }
      
      // 启用按钮点击事件
      enableBtn.onclick = () => {
        const wasEnabled = enableBtn.classList.contains('enabled');
        
        if (wasEnabled) {
          // 禁用连接
          enableBtn.classList.remove('enabled');
          enableBtn.title = '点击启用连接';
          linkGroup.style.display = 'none';
          valueGroup.style.display = '';
          
          // 创建禁用时的值输入控件
          if (dataType) {
            createValueInput(dataType, this.inputDisabledValues[key]?.value);
          } else {
            createDataTypeSelect();
            if (this.inputDisabledValues[key]?.dataType && this.inputDisabledValues[key].dataType !== 'null') {
              const select = valueGroup.querySelector('select');
              if (select) {
                select.value = this.inputDisabledValues[key].dataType;
                createValueInputInSpan(this.inputDisabledValues[key].dataType, this.inputDisabledValues[key].value, valueGroup.querySelector('span'));
              }
            }
          }
          
          // 保存设置
          this.inputLinkSettings[key] = {
            enabled: false,
            linkNodeId: idInput.value,
            linkOutputIndex: parseInt(outInput.value) || 0
          };
          console.log(`[ComfyUI Panel] Disabled link for ${key}:`, this.inputLinkSettings[key]);
        } else {
          // 启用连接（不改变当前值）
          enableBtn.classList.add('enabled');
          enableBtn.title = '点击禁用连接';
          linkGroup.style.display = '';
          valueGroup.style.display = 'none';
          
          // 保存设置
          this.inputLinkSettings[key] = {
            enabled: true,
            linkNodeId: idInput.value,
            linkOutputIndex: parseInt(outInput.value) || 0
          };
          console.log(`[ComfyUI Panel] Enabled link for ${key}:`, this.inputLinkSettings[key]);
        }
      };
      
      // ID输入变化
      idInput.oninput = () => {
        // 更新上游节点名称
        upstreamName.textContent = idInput.value ? (this.nodeIdToTitle[idInput.value] || '') : '';
        
        if (this.inputLinkSettings[key]) {
          this.inputLinkSettings[key].linkNodeId = idInput.value;
        } else {
          this.inputLinkSettings[key] = {
            enabled: enableBtn.classList.contains('enabled'),
            linkNodeId: idInput.value,
            linkOutputIndex: parseInt(outInput.value) || 0
          };
        }
      };
      
      // out输入变化
      outInput.oninput = () => {
        if (this.inputLinkSettings[key]) {
          this.inputLinkSettings[key].linkOutputIndex = parseInt(outInput.value) || 0;
        } else {
          this.inputLinkSettings[key] = {
            enabled: enableBtn.classList.contains('enabled'),
            linkNodeId: idInput.value,
            linkOutputIndex: parseInt(outInput.value) || 0
          };
        }
      };
      
      // 重置按钮点击 - 重置为原始值并启用
      resetBtn.onclick = () => {
        if (originalLink) {
          idInput.value = originalLink.linkNodeId;
          outInput.value = originalLink.linkOutputIndex;
          
          // 更新上游节点名称
          upstreamName.textContent = this.nodeIdToTitle[originalLink.linkNodeId] || '';
          
          // 启用连接
          enableBtn.classList.add('enabled');
          enableBtn.title = '点击禁用连接';
          linkGroup.style.display = '';
          valueGroup.style.display = 'none';
          
          this.inputLinkSettings[key] = {
            enabled: true,
            linkNodeId: originalLink.linkNodeId,
            linkOutputIndex: originalLink.linkOutputIndex
          };
        }
      };
      
      container.appendChild(enableBtn);
      container.appendChild(nameLabel);
      
      linkGroup.appendChild(upstreamName);
      linkGroup.appendChild(idLabel);
      linkGroup.appendChild(idInput);
      linkGroup.appendChild(outLabel);
      linkGroup.appendChild(outInput);
      linkGroup.appendChild(resetBtn);
      container.appendChild(linkGroup);
      
      container.appendChild(valueGroup);
      
      return container;
    }


    createFormInput(node, input) {
      const key = node.id + '.' + input.key;

      switch (input.widgetType) {
        case 'textarea':
          // 创建语法高亮容器
          const textareaContainer = document.createElement('div');
          textareaContainer.className = 'textarea-highlight-container';
          
          // 创建高亮显示层 (使用 pre 元素)
          const highlightPre = document.createElement('pre');
          highlightPre.className = 'textarea-highlight-pre';
          highlightPre.dataset.key = key;
          
          const textarea = document.createElement('textarea');
          textarea.className = 'form-input form-textarea form-textarea-highlight';
          // 使用保存的值，如果存在
          const savedValue = this.cardValues[key];
          textarea.value = savedValue !== undefined ? savedValue : (input.value || '');
          textarea.dataset.key = key;

          if (this.textareaHeights[key]) {
            textarea.style.height = this.textareaHeights[key];
          }

          // 初始渲染高亮
          this.renderTextareaHighlight(highlightPre, textarea.value);

          textarea.oninput = (e) => { 
            this.cardValues[key] = e.target.value;
            this.renderTextareaHighlight(highlightPre, e.target.value);
          };

          // 同步滚动
          textarea.onscroll = () => {
            highlightPre.scrollTop = textarea.scrollTop;
            highlightPre.scrollLeft = textarea.scrollLeft;
          };

          // Ctrl+双击触发注释/取消注释功能
          textarea.addEventListener('dblclick', (e) => {
            if (!e.ctrlKey) return;
            
            e.preventDefault();
            e.stopPropagation();
            
            const result = this.toggleCommentAtPosition(textarea, e);
            if (result.modified) {
              // 设置光标位置
              textarea.setSelectionRange(result.cursorOffset, result.cursorOffset);
              this.cardValues[key] = textarea.value;
              this.renderTextareaHighlight(highlightPre, textarea.value);
            }
          });

          // Ctrl+/ 快捷键注释/取消注释功能
          textarea.addEventListener('keydown', (e) => {
            if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              e.stopPropagation();
              
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              const value = textarea.value;

              // 获取当前行
              const lineStart = value.lastIndexOf('\n', start - 1) + 1;
              const lineEnd = value.indexOf('\n', end);
              const actualLineEnd = lineEnd === -1 ? value.length : lineEnd;

              const currentLine = value.substring(lineStart, actualLineEnd);
              
              // 检查是否有选中文本（且选中文本在同一行内）
              const hasSelection = start !== end;
              const selectionInSameLine = start >= lineStart && end <= actualLineEnd;
              
              if (hasSelection && selectionInSameLine) {
                // 有选中文本且在同一行内，注释/取消注释选中的提示词
                const result = this.togglePromptComment(currentLine, start - lineStart, end - lineStart);
                if (result.modified) {
                  const newValue = value.substring(0, lineStart) + result.line + value.substring(actualLineEnd);
                  textarea.value = newValue;
                  this.cardValues[key] = newValue;
                  
                  // 设置光标位置：移动到注释/取消注释的提示词的逗号后面
                  const newCursorPos = lineStart + result.cursorOffset;
                  textarea.setSelectionRange(newCursorPos, newCursorPos);
                  
                  // 更新高亮显示
                  this.renderTextareaHighlight(highlightPre, newValue);
                }
              } else {
                // 没有选中文本或选中文本跨行，注释/取消注释整行
                const selectedLines = value.substring(lineStart, actualLineEnd);
                const lines = selectedLines.split('\n');

                // 检查是否所有行都以 # 开头
                const allCommented = lines.every(line => line.trim().startsWith('#') || line.trim() === '');

                let newLines;
                if (allCommented) {
                  // 取消注释
                  newLines = lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('#')) {
                      const uncommented = trimmed.substring(1).trimStart();
                      const leadingSpaces = line.length - line.trimStart().length;
                      return ' '.repeat(leadingSpaces) + uncommented;
                    }
                    return line;
                  });
                } else {
                  // 添加注释
                  newLines = lines.map(line => {
                    if (line.trim() === '') return line;
                    const leadingSpaces = line.length - line.trimStart().length;
                    return ' '.repeat(leadingSpaces) + '# ' + line.trimStart();
                  });
                }

                const newValue = value.substring(0, lineStart) + newLines.join('\n') + value.substring(actualLineEnd);
                textarea.value = newValue;
                this.cardValues[key] = newValue;

                // 设置光标位置：移动到行末尾
                const newLineEnd = lineStart + newLines.join('\n').length;
                textarea.setSelectionRange(newLineEnd, newLineEnd);

                // 更新高亮显示
                this.renderTextareaHighlight(highlightPre, newValue);
              }
            }
          });

          const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target === textarea) {
                this.textareaHeights[key] = textarea.style.height;
              }
            }
          });
          resizeObserver.observe(textarea);

          // 阻止拖拽事件冒泡，防止在文本框空白区域拖拽时触发卡片拖拽
          textareaContainer.addEventListener('dragstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
          });

          textareaContainer.appendChild(highlightPre);
          textareaContainer.appendChild(textarea);
          return textareaContainer;
        case 'number':
          const numberInput = document.createElement('input');
          numberInput.type = 'number';
          numberInput.className = 'form-input';
          const savedNumValue = this.cardValues[key];
          numberInput.value = savedNumValue !== undefined ? savedNumValue : (input.value || 0);
          
          // 根据输入值的类型设置步进
          // 如果原始值是小数，使用 0.01 步进；如果是整数，使用 1 步进
          const originalValue = input.value;
          if (originalValue !== undefined && originalValue !== null && !Number.isInteger(originalValue)) {
            numberInput.step = '0.01';
          } else {
            numberInput.step = '1';
          }
          
          numberInput.oninput = (e) => { this.cardValues[key] = parseFloat(e.target.value) || 0; };
          return numberInput;
        case 'checkbox':
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          const savedCheckValue = this.cardValues[key];
          checkbox.checked = savedCheckValue !== undefined ? savedCheckValue : (input.value || false);
          checkbox.style.width = '14px';
          checkbox.style.height = '14px';
          checkbox.onchange = (e) => { this.cardValues[key] = e.target.checked; };
          return checkbox;
        case 'image':
          return this.createImageUpload(node, input, key);
        case 'dropdown':
          const select = document.createElement('select');
          select.className = 'form-select';
          const optionMaps = {
            'sampler_name': ['euler', 'euler_ancestral', 'heun', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'ddim', 'uni_pc'],
            'scheduler': ['normal', 'karras', 'exponential', 'sgm_uniform', 'simple', 'ddim_uniform'],
          };
          const savedSelectValue = this.cardValues[key];
          const options = optionMaps[input.key] || [String(input.value)];
          options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt;
            if (opt === (savedSelectValue !== undefined ? savedSelectValue : input.value)) option.selected = true;
            select.appendChild(option);
          });
          select.onchange = (e) => { this.cardValues[key] = e.target.value; };
          
          const container = document.createElement('div');
          container.style.display = 'flex';
          container.style.alignItems = 'center';
          container.style.gap = '4px';
          container.appendChild(select);
          
          const refreshBtn = document.createElement('button');
          refreshBtn.className = 'panel-btn panel-btn-secondary panel-btn-small';
          refreshBtn.innerHTML = '🔄';
          refreshBtn.title = '刷新列表';
          refreshBtn.onclick = () => this.refreshDropdownOptions(select, input.key, key);
          container.appendChild(refreshBtn);
          
          return container;
        default:
          const textInput = document.createElement('input');
          textInput.type = 'text';
          textInput.className = 'form-input';
          const savedTextValue = this.cardValues[key];
          textInput.value = savedTextValue !== undefined ? savedTextValue : (input.value || '');
          textInput.oninput = (e) => { this.cardValues[key] = e.target.value; };
          return textInput;
      }
    }

    async refreshDropdownOptions(select, inputKey, cardKey) {
      const baseUrl = this.baseUrl;
      try {
        if (inputKey.includes('ckpt_name')) {
          const response = await fetch(baseUrl + '/comfyui_panel/list_models?type=checkpoints&t=' + Date.now());
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          
          if (data.success && data.files) {
            select.innerHTML = '';
            data.files.forEach(file => {
              const option = document.createElement('option');
              option.value = file.name;
              option.textContent = file.name;
              select.appendChild(option);
            });
            // 刷新后更新 cardValues 为当前选中的值
            if (cardKey && select.value) {
              this.cardValues[cardKey] = select.value;
            }
            this.showToast(`已加载 ${data.count} 个模型`);
          } else {
            throw new Error(data.error || 'Unknown error');
          }
        }
      } catch (e) {
        console.error('[ComfyUI Panel] 刷新下拉列表失败:', e);
        this.showToast('刷新失败: ' + e.message, 3000);
      }
    }

    /**
     * 渲染textarea语法高亮
     * @param {HTMLElement} highlightEl - 高亮显示层元素 (pre)
     * @param {string} text - 文本内容
     */
    renderTextareaHighlight(highlightEl, text) {
      if (!text) {
        highlightEl.textContent = '';
        return;
      }

      // 获取高亮颜色
      const colorA = this.highlightColorA || '#6496c8';
      const colorB = this.highlightColorB || '#c89664';

      // 按行处理
      const lines = text.split('\n');
      const fragment = document.createDocumentFragment();

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        
        // 检查是否是注释行（以 # 开头）
        const isCommentLine = line.trimStart().startsWith('#');
        
        if (isCommentLine) {
          // 整行注释，显示深绿色
          const span = document.createElement('span');
          span.className = 'hl-comment';
          span.textContent = line;
          fragment.appendChild(span);
        } else {
          // 按逗号分割，交替背景色
          // 使用正则分割，保留逗号
          const segments = line.split(/(,)/);
          let bgIndex = 0;
          
          for (const segment of segments) {
            if (segment === ',') {
              fragment.appendChild(document.createTextNode(','));
            } else if (segment) {
              // 检查是否是注释片段（以 # 开头）
              const isCommentSegment = segment.trimStart().startsWith('#');
              
              // 使用自定义颜色
              const bgColor = bgIndex % 2 === 0 ? colorA : colorB;
              
              const span = document.createElement('span');
              span.className = 'hl-seg';
              span.style.backgroundColor = bgColor + '26'; // 添加透明度 (26 = 15% opacity in hex)
              
              if (isCommentSegment) {
                const inner = document.createElement('span');
                inner.className = 'hl-comment';
                inner.textContent = segment;
                span.appendChild(inner);
              } else {
                // 检查是否有权重并提取权重值
                const weightMatch = segment.match(/:(\d+\.?\d*)/);
                if (weightMatch) {
                  const weight = parseFloat(weightMatch[1]);
                  const inner = document.createElement('span');
                  inner.className = 'hl-weighted';
                  inner.textContent = segment;
                  // 根据权重值计算颜色 (0-2.5 映射到浅红# c56e6e 到暗红#890000)
                  const color = this.getWeightColor(weight);
                  inner.style.color = color;
                  span.appendChild(inner);
                } else {
                  span.textContent = segment;
                }
              }
              
              fragment.appendChild(span);
              bgIndex++;
            }
          }
        }
        
        // 添加换行（除了最后一行）
        if (lineIndex < lines.length - 1) {
          fragment.appendChild(document.createTextNode('\n'));
        }
      }

      highlightEl.innerHTML = '';
      highlightEl.appendChild(fragment);
    }

    /**
     * 根据权重值计算颜色
     * @param {number} weight - 权重值 (0-2.5+)
     * @returns {string} - 颜色值
     */
    getWeightColor(weight) {
      // 限制范围 0-2.5
      const clampedWeight = Math.max(0, Math.min(2.5, weight));
      // 计算比例 (0-1)
      const ratio = clampedWeight / 2.5;
      
      // 浅红色 #c56e6e -> 暗红色 #890000
      // R: 197 -> 137
      // G: 110 -> 0
      // B: 110 -> 0
      const r = Math.round(197 - (197 - 137) * ratio);
      const g = Math.round(110 - 110 * ratio);
      const b = Math.round(110 - 110 * ratio);
      
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
    }

    /**
     * HTML转义
     * @param {string} text - 原始文本
     * @returns {string} - 转义后的文本
     */
    escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    /**
     * Ctrl+双击触发注释/取消注释功能
     * @param {HTMLTextAreaElement} textarea - 文本框元素
     * @param {MouseEvent} e - 鼠标事件
     * @returns {{modified: boolean, cursorOffset: number, lineStartPos: number}} - 是否修改了内容、光标偏移量、行起始位置
     */
    toggleCommentAtPosition(textarea, e) {
      const value = textarea.value;
      if (!value) return { modified: false, cursorOffset: 0, lineStartPos: 0 };

      // 获取双击位置对应的字符索引
      const clickIndex = this.getClickCharIndex(textarea, e);
      if (clickIndex === -1) return { modified: false, cursorOffset: 0, lineStartPos: 0 };

      // 找到双击位置所在的行
      const lines = value.split('\n');
      let currentPos = 0;
      let lineIndex = 0;
      let lineStartPos = 0;
      
      for (let i = 0; i < lines.length; i++) {
        const lineLength = lines[i].length;
        if (currentPos + lineLength >= clickIndex) {
          lineIndex = i;
          lineStartPos = currentPos;
          break;
        }
        currentPos += lineLength + 1; // +1 for newline
      }

      const currentLine = lines[lineIndex];
      const clickPosInLine = clickIndex - lineStartPos;

      // 判断双击位置是否在行首（去除空白后的第一个非空白字符之前）
      const trimmedLine = currentLine.trimStart();
      const leadingSpaces = currentLine.length - trimmedLine.length;
      const isFirstPrompt = clickPosInLine <= leadingSpaces + trimmedLine.length && 
                            (clickPosInLine <= leadingSpaces || clickPosInLine === 0);

      if (isFirstPrompt && clickPosInLine <= leadingSpaces + 10) {
        // 双击位置在行首附近，注释/取消注释整行
        const result = this.toggleLineComment(currentLine);
        lines[lineIndex] = result.line;
        textarea.value = lines.join('\n');
        // 光标移动到整行末尾
        const newLineEnd = lineStartPos + lines[lineIndex].length;
        return { modified: true, cursorOffset: newLineEnd, lineStartPos };
      } else {
        // 双击位置不在行首，找到并注释双击位置的提示词
        const result = this.togglePromptComment(currentLine, clickPosInLine);
        if (result.modified) {
          lines[lineIndex] = result.line;
          textarea.value = lines.join('\n');
          // 光标位置是相对于行起始位置的偏移
          return { modified: true, cursorOffset: lineStartPos + result.cursorOffset, lineStartPos };
        }
      }

      return { modified: false, cursorOffset: clickIndex, lineStartPos: 0 };
    }

    /**
     * 根据鼠标点击位置获取字符索引
     * @param {HTMLTextAreaElement} textarea - 文本框元素
     * @param {MouseEvent} e - 鼠标事件
     * @returns {number} - 字符索引
     */
    getClickCharIndex(textarea, e) {
      // 对于 textarea，最可靠的方法是使用双击后的 selectionStart
      // 因为双击会自动将光标移动到点击位置
      // 使用 setTimeout 确保在双击事件处理后再获取位置
      return textarea.selectionStart;
    }

    /**
     * 注释/取消注释整行
     * @param {string} line - 当前行文本
     * @returns {{line: string, wasCommented: boolean}} - 处理后的行和是否原来是注释
     */
    toggleLineComment(line) {
      const trimmed = line.trimStart();
      const leadingSpaces = line.length - trimmed.length;
      const spaces = line.substring(0, leadingSpaces);
      
      // 检查是否已经是注释（以 # 开头，忽略空白）
      if (trimmed.startsWith('#')) {
        // 取消注释：移除 # 和后面可能的一个空格
        let uncommented = trimmed.substring(1);
        if (uncommented.startsWith(' ')) {
          uncommented = uncommented.substring(1);
        }
        return { line: spaces + uncommented, wasCommented: true };
      } else {
        // 添加注释
        return { line: spaces + '# ' + trimmed, wasCommented: false };
      }
    }

    /**
     * 注释/取消注释指定位置的提示词
     * @param {string} line - 当前行文本
     * @param {number} startPos - 选区开始位置（行内索引）
     * @param {number} endPos - 选区结束位置（行内索引），可选
     * @returns {{line: string, modified: boolean, cursorOffset: number}} - 处理后的行、是否修改了、光标偏移量
     */
    togglePromptComment(line, startPos, endPos = startPos) {
      // 提示词通常以逗号分隔
      // 找到选区位置所在的提示词
      const segments = [];
      let currentSegment = '';
      let segmentStart = 0;
      let inBrackets = 0; // 处理括号内的逗号
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (char === '(' || char === '[' || char === '{') {
          inBrackets++;
          currentSegment += char;
        } else if (char === ')' || char === ']' || char === '}') {
          inBrackets--;
          currentSegment += char;
        } else if (char === ',' && inBrackets === 0) {
          segments.push({
            text: currentSegment,
            start: segmentStart,
            end: i
          });
          currentSegment = '';
          segmentStart = i + 1;
        } else {
          currentSegment += char;
        }
      }
      
      // 添加最后一个分段
      if (currentSegment || segments.length > 0) {
        segments.push({
          text: currentSegment,
          start: segmentStart,
          end: line.length
        });
      }

      // 如果没有分段，整行作为一个分段
      if (segments.length === 0) {
        segments.push({
          text: line,
          start: 0,
          end: line.length
        });
      }

      // 找到选区位置所在的分段
      let targetSegment = null;
      for (const seg of segments) {
        if (startPos >= seg.start && startPos <= seg.end) {
          targetSegment = seg;
          break;
        }
      }

      if (!targetSegment) {
        return { line, modified: false, cursorOffset: startPos };
      }

      // 检查该分段是否已经是注释
      const trimmedSeg = targetSegment.text.trim();
      const segLeadingSpaces = targetSegment.text.length - trimmedSeg.length;
      
      let newLine;
      let newSegText;
      let cursorOffset;
      
      if (trimmedSeg.startsWith('#')) {
        // 取消注释该分段
        let uncommented = trimmedSeg.substring(1);
        if (uncommented.startsWith(' ')) {
          uncommented = uncommented.substring(1);
        }
        newSegText = targetSegment.text.substring(0, segLeadingSpaces) + uncommented;
        
        // 重建行
        newLine = line.substring(0, targetSegment.start) + newSegText + line.substring(targetSegment.end);
        
        // 计算光标位置：移动到提示词后面的逗号位置
        // 取消注释后，提示词长度减少了2（# 和空格）
        const newSegEnd = targetSegment.start + newSegText.length;
        // 查找提示词后面的逗号
        const commaAfterSeg = newLine.indexOf(',', newSegEnd);
        if (commaAfterSeg !== -1 && commaAfterSeg < newLine.length) {
          // 有逗号，移动到逗号后面
          cursorOffset = commaAfterSeg + 1;
        } else {
          // 没有逗号，移动到提示词末尾
          cursorOffset = newSegEnd;
        }
      } else {
        // 注释该分段
        newSegText = targetSegment.text.substring(0, segLeadingSpaces) + '# ' + trimmedSeg;
        
        // 重建行
        newLine = line.substring(0, targetSegment.start) + newSegText + line.substring(targetSegment.end);
        
        // 计算光标位置：移动到注释后的提示词后面的逗号位置
        // 注释后，提示词长度增加了2（# 和空格）
        const newSegEnd = targetSegment.start + newSegText.length;
        // 查找提示词后面的逗号
        const commaAfterSeg = newLine.indexOf(',', newSegEnd);
        if (commaAfterSeg !== -1 && commaAfterSeg < newLine.length) {
          // 有逗号，移动到逗号后面
          cursorOffset = commaAfterSeg + 1;
        } else {
          // 没有逗号，移动到提示词末尾
          cursorOffset = newSegEnd;
        }
      }
      
      return { line: newLine, modified: true, cursorOffset };
    }

    /**
     * 标记某个图片卡片的裁剪为脏，并触发防抖上传
     * @param {string} key - 图片卡片的key
     * @param {boolean} immediate - 是否立即开始计时（false表示正在调整中，暂不计时）
     */
    markCropDirtyAndScheduleUpload(key, immediate = true) {
      const cropInfo = this.imageCropData[key];
      if (!cropInfo) return;

      cropInfo.needsUpload = true;

      // 清除之前的定时器
      if (cropInfo.uploadTimer) {
        clearTimeout(cropInfo.uploadTimer);
        cropInfo.uploadTimer = null;
      }

      // 如果正在调整裁剪框，不触发上传
      if (cropInfo.isAdjusting) {
        return;
      }

      // 设置新的防抖定时器（1000ms）
      cropInfo.uploadTimer = setTimeout(() => {
        // 再次检查是否正在调整
        if (!cropInfo.isAdjusting) {
          this.uploadCroppedImage(key);
        }
        cropInfo.uploadTimer = null;
      }, 1000);
    }

    /**
     * 开始调整裁剪框（鼠标按下时调用）
     */
    startCropAdjust(key) {
      const cropInfo = this.imageCropData[key];
      if (!cropInfo) return;
      
      cropInfo.isAdjusting = true;
      
      // 清除之前的上传定时器
      if (cropInfo.uploadTimer) {
        clearTimeout(cropInfo.uploadTimer);
        cropInfo.uploadTimer = null;
      }
    }

    /**
     * 结束调整裁剪框（鼠标释放时调用）
     */
    endCropAdjust(key) {
      const cropInfo = this.imageCropData[key];
      if (!cropInfo) return;
      
      cropInfo.isAdjusting = false;
      
      // 标记为脏并开始1秒倒计时
      cropInfo.needsUpload = true;
      
      // 清除之前的定时器
      if (cropInfo.uploadTimer) {
        clearTimeout(cropInfo.uploadTimer);
        cropInfo.uploadTimer = null;
      }
      
      // 设置新的防抖定时器（1000ms）
      cropInfo.uploadTimer = setTimeout(() => {
        if (!cropInfo.isAdjusting && cropInfo.needsUpload) {
          this.uploadCroppedImage(key);
        }
        cropInfo.uploadTimer = null;
      }, 1000);
    }

    /**
     * 上传单个裁剪后的图片
     */
    async uploadCroppedImage(key) {
      const cropInfo = this.imageCropData[key];
      if (!cropInfo || !cropInfo.needsUpload) return;

      const data = cropInfo.getData();
      if (!data || !data.img) return;

      // 执行 Canvas 裁剪并缩放到目标分辨率
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const scaleX = data.img.naturalWidth / data.width;
      const scaleY = data.img.naturalHeight / data.height;
      
      // 使用用户设置的裁剪分辨率作为输出尺寸
      const targetWidth = this.globalCropSize.width;
      const targetHeight = this.globalCropSize.height;
      
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      
      // 先裁剪原图，然后缩放到目标分辨率
      ctx.drawImage(
        data.img,
        data.cropX * scaleX,
        data.cropY * scaleY,
        data.cropW * scaleX,
        data.cropH * scaleY,
        0,
        0,
        targetWidth,
        targetHeight
      );

      let blob;
      try {
        blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error('Failed to create blob'));
          }, 'image/png');
        });
      } catch (e) {
        // 跨域错误：canvas 被污染
        console.warn('[ComfyUI Panel] Canvas tainted, skipping crop upload:', e.message);
        // 清除脏标记，使用原始图片
        cropInfo.needsUpload = false;
        this.showToast('跨域限制：无法裁剪远程图片，使用原图');
        return;
      }
      
      const filename = `panel_crop_node_${cropInfo.nodeId}.png`;

      // 检查是否启用本地输出
      const localConfig = cropInfo.getLocalOutputConfig ? cropInfo.getLocalOutputConfig() : { enabled: false, directory: '' };
      if (localConfig.enabled) {
        // 触发浏览器下载
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        // 构建下载文件名：子目录/文件名
        const downloadFilename = localConfig.directory
          ? `${localConfig.directory}/${filename}`
          : filename;
        a.download = downloadFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        this.showToast(`已下载: ${downloadFilename}`);
      }

      const formData = new FormData();
      formData.append('image', blob, filename);
      formData.append('filename', filename);
      formData.append('overwrite', 'true');

      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/upload_crop', {
          method: 'POST',
          body: formData
        });
        const result = await response.json();

        if (result.success) {
          // 更新 cardValues 中的值为上传后的文件名
          this.cardValues[key] = result.name;
          // 清除脏标记
          cropInfo.needsUpload = false;
          if (!localConfig.enabled) {
            this.showToast(`裁剪图片已更新: ${result.name}`);
          }
        } else {
          console.error('[ComfyUI Panel] 裁剪图片上传失败', result.error);
        }
      } catch (e) {
        console.error('[ComfyUI Panel] 裁剪图片上传失败', e);
      }
    }

    createImageUpload(node, input, key) {
      const self = this;
      const wrapper = document.createElement('div');
      wrapper.style.marginTop = '-10px'; // 抵消 form-group 的 margin-bottom
      const container = document.createElement('div');
      container.className = 'image-upload-container';
      container.innerHTML = '<div class="image-placeholder">点击下方按钮上传、拖拽图片或按 V 键粘贴</div>';

      const fileListRow = document.createElement('div');
      fileListRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 6px; align-items: center;';

      const fileSelect = document.createElement('select');
      fileSelect.className = 'form-select';
      fileSelect.style.flex = '1';
      fileSelect.innerHTML = '<option value="">-- 选择文件 --</option>';

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'panel-btn panel-btn-secondary panel-btn-small';
      refreshBtn.innerHTML = '🔄';
      refreshBtn.title = '刷新文件列表';
      refreshBtn.onclick = () => this.loadInputFileList(fileSelect);

      fileListRow.appendChild(fileSelect);
      fileListRow.appendChild(refreshBtn);

      fileSelect.onchange = (e) => {
        const filename = e.target.value;
        if (!filename) return;

        pathGroup.querySelector('input').value = filename;

        const img = this.createImageElement();
        img.onload = () => handleImageLoad(img, filename);
        img.onerror = () => {
          container.innerHTML = `<div class="image-placeholder">加载失败: ${filename}</div>`;
          container.classList.remove('has-image');
        };
        img.src = this.baseUrl + `/view?filename=${encodeURIComponent(filename)}&type=input&t=${Date.now()}`;
      };

      const pathGroup = document.createElement('div');
      pathGroup.className = 'path-input-group';
      const savedPath = this.cardValues[key];
      pathGroup.innerHTML = `<input type="text" class="form-input" placeholder="路径" value="${savedPath || input.value || ''}"><button class="panel-btn panel-btn-secondary panel-btn-small">加载</button><button class="panel-btn panel-btn-secondary panel-btn-small open-btn">打开</button>`;

      // 常用分辨率预设下拉列表
      const resolutionPreset = document.createElement('div');
      resolutionPreset.className = 'resolution-preset';
      resolutionPreset.innerHTML = `
        <select class="resolution-select">
          <option value="">常用分辨率</option>
          <option value="512x512">512 × 512 (正方形)</option>
          <option value="768x1024">768 × 1024 (竖版)</option>
          <option value="896x1152">896 × 1152 (竖版)</option>
          <option value="896x1536">896 × 1536 (竖版)</option>
          <option value="1024x1024">1024 × 1024 (正方形)</option>
          <option value="1024x1365">1024 × 1365 (3:4)</option>
          <option value="1024x1536">1024 × 1536 (2:3)</option>
          <option value="1152x896">1152 × 896 (横版)</option>
          <option value="1280x720">1280 × 720 (16:9)</option>
          <option value="1344x768">1344 × 768 (横版)</option>
          <option value="1536x896">1536 × 896 (横版)</option>
          <option value="1536x1024">1536 × 1024 (3:2)</option>
          <option value="1920x1080">1920 × 1080 (16:9)</option>
        </select>
      `;

      // 创建包含分辨率下拉列表和路径输入的行容器
      const resolutionPathRow = document.createElement('div');
      resolutionPathRow.className = 'resolution-path-row';
      resolutionPathRow.appendChild(resolutionPreset);
      resolutionPathRow.appendChild(pathGroup);

      const cropSettings = document.createElement('div');
      cropSettings.className = 'crop-settings';
      cropSettings.innerHTML = `
        <span style="color: rgba(255,255,255,0.6); font-size: 10px;">裁剪:</span>
        <input type="number" class="form-input crop-width" value="${this.globalCropSize.width}" min="64" max="4096">
        <button class="panel-btn panel-btn-secondary swap-btn" title="交换宽高">⇄</button>
        <input type="number" class="form-input crop-height" value="${this.globalCropSize.height}" min="64" max="4096">
        <button class="panel-btn panel-btn-secondary link-btn ${this.linkCropSize ? 'active' : ''}">🔗</button>
        <button class="panel-btn panel-btn-secondary panel-btn-small max-btn">最大</button>
        <button class="panel-btn panel-btn-secondary panel-btn-small upload-btn">📁</button>
        <button class="panel-btn panel-btn-secondary panel-btn-small paste-btn">📋</button>
      `;

      // 本地输出设置
      const localOutputSettings = document.createElement('div');
      localOutputSettings.className = 'local-output-settings';
      localOutputSettings.innerHTML = `
        <label class="local-output-toggle" style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-top: 6px;">
          <input type="checkbox" class="local-output-enabled" style="width: 14px; height: 14px;">
          <span style="color: rgba(255,255,255,0.7); font-size: 12px;">输出到本地</span>
        </label>
        <div class="local-output-path" style="display: none; margin-top: 4px;">
          <input type="text" class="form-input local-output-dir" placeholder="子目录名称 (如: cropped_images)" style="font-size: 12px;">
        </div>
      `;

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.style.display = 'none';

      let currentImageData = null;
      let cropBox = null;

      const updateCropSize = () => {
        const w = parseInt(cropSettings.querySelector('.crop-width').value) || 896;
        const h = parseInt(cropSettings.querySelector('.crop-height').value) || 1536;
        if (this.linkCropSize) {
          this.globalCropSize = { width: w, height: h };
          document.querySelectorAll('.crop-settings .crop-width').forEach(el => el.value = w);
          document.querySelectorAll('.crop-settings .crop-height').forEach(el => el.value = h);
        }
        if (currentImageData && cropBox && currentImageData.imgEl) this.updateCropBox(cropBox, currentImageData.imgEl, currentImageData, w, h);
        // 尺寸变化触发脏标记
        if (currentImageData) {
          self.markCropDirtyAndScheduleUpload(key);
        }
      };

      // 对换宽高按钮事件
      const swapWidthHeight = () => {
        const widthInput = cropSettings.querySelector('.crop-width');
        const heightInput = cropSettings.querySelector('.crop-height');
        const w = parseInt(widthInput.value) || 896;
        const h = parseInt(heightInput.value) || 1536;
        widthInput.value = h;
        heightInput.value = w;
        updateCropSize();
        // 如果链接按钮处于选中状态，执行所有图像卡片的最大化
        if (this.linkCropSize) {
          this.maximizeAllImageCards();
        }
      };

      // 分辨率预设选择事件
      const onResolutionPresetChange = (e) => {
        const value = e.target.value;
        if (!value) return;
        const [w, h] = value.split('x').map(v => parseInt(v));
        const widthInput = cropSettings.querySelector('.crop-width');
        const heightInput = cropSettings.querySelector('.crop-height');
        widthInput.value = w;
        heightInput.value = h;
        updateCropSize();
        // 如果链接按钮处于选中状态，执行所有图像卡片的最大化
        if (this.linkCropSize) {
          this.maximizeAllImageCards();
        }
        // 重置下拉列表选中状态
        e.target.value = '';
      };

      const maximizeCrop = () => {
        if (!currentImageData || !cropBox || !currentImageData.imgEl) return;
        const w = parseInt(cropSettings.querySelector('.crop-width').value) || 896;
        const h = parseInt(cropSettings.querySelector('.crop-height').value) || 1536;
        this.maximizeCropBox(cropBox, currentImageData.imgEl, currentImageData, w, h);
        // 最大化后触发脏标记
        self.markCropDirtyAndScheduleUpload(key);
      };

      cropSettings.querySelector('.crop-width').oninput = updateCropSize;
      cropSettings.querySelector('.crop-height').oninput = updateCropSize;
      cropSettings.querySelector('.swap-btn').onclick = swapWidthHeight;
      cropSettings.querySelector('.link-btn').onclick = (e) => { this.linkCropSize = !this.linkCropSize; e.target.classList.toggle('active', this.linkCropSize); };
      cropSettings.querySelector('.max-btn').onclick = maximizeCrop;
      resolutionPreset.querySelector('.resolution-select').onchange = onResolutionPresetChange;

      const handleImageLoad = (img, filename) => {
        currentImageData = {
          img: img,
          filename: filename,
          width: img.width,
          height: img.height,
          cropX: 0,
          cropY: 0,
          cropW: img.width,
          cropH: img.height,
          displayWidth: 0,
          displayHeight: 0,
          scale: 1,
          imgEl: null
        };
        container.innerHTML = '';
        container.classList.add('has-image');
        const previewWrapper = document.createElement('div');
        previewWrapper.className = 'image-preview-wrapper';
        const imgEl = document.createElement('img');
        imgEl.src = img.src;
        previewWrapper.appendChild(imgEl);
        const cropOverlay = document.createElement('div');
        cropOverlay.className = 'crop-overlay';
        const cropW = parseInt(cropSettings.querySelector('.crop-width').value) || 896;
        const cropH = parseInt(cropSettings.querySelector('.crop-height').value) || 1536;
        cropBox = document.createElement('div');
        cropBox.className = 'crop-box';
        ['nw', 'ne', 'sw', 'se'].forEach(pos => {
          const handle = document.createElement('div');
          handle.className = `crop-resize-handle ${pos}`;
          cropBox.appendChild(handle);
        });
        const cropInfo = document.createElement('div');
        cropInfo.className = 'crop-info';
        cropBox.appendChild(cropInfo);
        cropOverlay.appendChild(cropBox);
        previewWrapper.appendChild(cropOverlay);
        container.appendChild(previewWrapper);

        // 存储 imgEl 引用
        currentImageData.imgEl = imgEl;

        // 等待图片渲染完成后获取实际显示尺寸
        requestAnimationFrame(() => {
          const rect = imgEl.getBoundingClientRect();
          currentImageData.displayWidth = rect.width;
          currentImageData.displayHeight = rect.height;
          currentImageData.scale = rect.width / img.width;
          this.initCropBox(cropBox, imgEl, cropW, cropH, currentImageData);
          this.maximizeCropBox(cropBox, imgEl, currentImageData, cropW, cropH);
          this.bindCropDrag(cropBox, imgEl, cropSettings, currentImageData, key); // 传入 key
        });

        // 监听图片尺寸变化，自动调整裁剪框
        const resizeObserver = new ResizeObserver((entries) => {
          if (!currentImageData || !cropBox) return;
          const entry = entries[0];
          if (!entry) return;
          
          const newDisplayW = entry.contentRect.width;
          const newDisplayH = entry.contentRect.height;
          
          // 如果尺寸没有变化，跳过
          if (Math.abs(newDisplayW - currentImageData.displayWidth) < 1 && 
              Math.abs(newDisplayH - currentImageData.displayHeight) < 1) return;
          
          // 计算当前裁剪框在原图中的比例位置
          const ratioX = currentImageData.cropX / currentImageData.width;
          const ratioY = currentImageData.cropY / currentImageData.height;
          const ratioW = currentImageData.cropW / currentImageData.width;
          const ratioH = currentImageData.cropH / currentImageData.height;
          
          // 更新显示尺寸
          currentImageData.displayWidth = newDisplayW;
          currentImageData.displayHeight = newDisplayH;
          currentImageData.scale = newDisplayW / currentImageData.width;
          
          // 按比例重新计算裁剪框位置和大小
          let newCropX = ratioX * currentImageData.width;
          let newCropY = ratioY * currentImageData.height;
          let newCropW = ratioW * currentImageData.width;
          let newCropH = ratioH * currentImageData.height;
          
          // 边界检查：确保裁剪框不超出图片范围
          newCropW = Math.min(newCropW, currentImageData.width);
          newCropH = Math.min(newCropH, currentImageData.height);
          newCropX = Math.max(0, Math.min(newCropX, currentImageData.width - newCropW));
          newCropY = Math.max(0, Math.min(newCropY, currentImageData.height - newCropH));
          
          // 更新裁剪数据
          currentImageData.cropX = newCropX;
          currentImageData.cropY = newCropY;
          currentImageData.cropW = newCropW;
          currentImageData.cropH = newCropH;
          
          // 更新裁剪框显示
          cropBox.style.left = (newCropX * currentImageData.scale) + 'px';
          cropBox.style.top = (newCropY * currentImageData.scale) + 'px';
          cropBox.style.width = (newCropW * currentImageData.scale) + 'px';
          cropBox.style.height = (newCropH * currentImageData.scale) + 'px';
          
          // 更新裁剪信息显示
          const cropInfo = cropBox.querySelector('.crop-info');
          if (cropInfo) cropInfo.textContent = `${Math.round(newCropW)} × ${Math.round(newCropH)}`;
        });
        resizeObserver.observe(imgEl);

        // 图片加载并最大化后，认为裁剪已确定，标记为需要上传（立即触发防抖）
        self.cardValues[key] = filename;
        self.markCropDirtyAndScheduleUpload(key);
      };

      cropSettings.querySelector('.upload-btn').onclick = () => fileInput.click();
      fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = new Image();
          img.onload = () => handleImageLoad(img, file.name);
          img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
      };

      cropSettings.querySelector('.paste-btn').onclick = async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            for (const type of item.types) {
              if (type.startsWith('image/')) {
                const blob = await item.getType(type);
                const url = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => { handleImageLoad(img, 'pasted_image.png'); URL.revokeObjectURL(url); };
                img.src = url;
                return;
              }
            }
          }
          alert('剪贴板中没有图像');
        } catch (e) { alert('粘贴失败'); }
      };

      // 加载按钮事件
      pathGroup.querySelector('button:not(.open-btn)').onclick = () => {
        const path = pathGroup.querySelector('input').value.trim();
        if (!path) return;
        this.cardValues[key] = path;
        const img = this.createImageElement();
        img.onload = () => {
          handleImageLoad(img, path);
        };
        img.onerror = () => {
          container.innerHTML = `<div class="image-placeholder">✓ ${path}</div>`;
          container.classList.add('has-image');
        };
        img.src = this.baseUrl + `/view?filename=${encodeURIComponent(path)}&type=input`;
      };

      // 打开按钮事件
      pathGroup.querySelector('.open-btn').onclick = () => {
        fileInput.click();
      };

      const savedFilename = this.cardValues[key];
      if (savedFilename) {
        const img = this.createImageElement();
        img.onload = () => handleImageLoad(img, savedFilename);
        img.onerror = () => {
          container.innerHTML = `<div class="image-placeholder">✓ ${savedFilename}</div>`;
          container.classList.add('has-image');
        };
        img.src = this.baseUrl + `/view?filename=${encodeURIComponent(savedFilename)}&type=input`;
      } else if (input.value) {
        const img = this.createImageElement();
        img.onload = () => handleImageLoad(img, input.value);
        img.onerror = () => {
          container.innerHTML = `<div class="image-placeholder">✓ ${input.value}</div>`;
          container.classList.add('has-image');
        };
        img.src = this.baseUrl + `/view?filename=${encodeURIComponent(input.value)}&type=input`;
      }

      wrapper.appendChild(fileListRow);
      wrapper.appendChild(container);
      wrapper.appendChild(resolutionPathRow);
      wrapper.appendChild(cropSettings);
      wrapper.appendChild(localOutputSettings);
      wrapper.appendChild(fileInput);

      // 本地输出复选框事件绑定
      const localOutputEnabled = localOutputSettings.querySelector('.local-output-enabled');
      const localOutputPath = localOutputSettings.querySelector('.local-output-path');
      const localOutputDir = localOutputSettings.querySelector('.local-output-dir');

      localOutputEnabled.onchange = (e) => {
        localOutputPath.style.display = e.target.checked ? 'block' : 'none';
      };

      // 存储图片卡片相关信息，包括 nodeId, inputKey 等
      this.imageCropData[key] = {
        container: container,
        cropSettings: cropSettings,
        localOutputSettings: localOutputSettings,
        getData: () => currentImageData,
        handleImageLoad: handleImageLoad,
        nodeId: node.id,
        inputKey: input.key,
        needsUpload: false,          // 初始为 false
        uploadTimer: null,
        isAdjusting: false,          // 是否正在调整裁剪框
        getLocalOutputConfig: () => ({
          enabled: localOutputEnabled.checked,
          directory: localOutputDir.value.trim()
        }),
        setLocalOutputConfig: (config) => {
          if (config) {
            localOutputEnabled.checked = config.enabled || false;
            localOutputDir.value = config.directory || '';
            localOutputPath.style.display = config.enabled ? 'block' : 'none';
          }
        },
        restore: (filename, cropParams) => {
          const img = this.createImageElement();
          img.onload = () => {
            handleImageLoad(img, filename);
            if (cropParams && cropParams.cropX !== undefined) {
              setTimeout(() => {
                if (cropBox && currentImageData) {
                  currentImageData.cropX = cropParams.cropX;
                  currentImageData.cropY = cropParams.cropY;
                  currentImageData.cropW = cropParams.cropW;
                  currentImageData.cropH = cropParams.cropH;
                  const rect = container.querySelector('img').getBoundingClientRect();
                  cropBox.style.left = (cropParams.cropX / currentImageData.width * 100) + '%';
                  cropBox.style.top = (cropParams.cropY / currentImageData.height * 100) + '%';
                  cropBox.style.width = (cropParams.cropW / currentImageData.width * 100) + '%';
                  cropBox.style.height = (cropParams.cropH / currentImageData.height * 100) + '%';
                  const cropInfo = cropBox.querySelector('.crop-info');
                  if (cropInfo) cropInfo.textContent = `${Math.round(cropParams.cropW)} × ${Math.round(cropParams.cropH)}`;
                }
              }, 100);
            }
            // 恢复后认为是已上传状态，无需再次上传
            if (this.imageCropData[key]) {
              this.imageCropData[key].needsUpload = false;
            }
          };
          img.onerror = () => {
            container.innerHTML = `<div class="image-placeholder">✓ ${filename}</div>`;
            container.classList.add('has-image');
          };
          img.src = this.baseUrl + `/view?filename=${encodeURIComponent(filename)}&type=input`;
        }
      };

      this.bindImageDragDrop(container, handleImageLoad, key); // 传入 key

      this.loadInputFileList(fileSelect);

      return wrapper;
    }

    bindImageDragDrop(container, handleImageLoad, key) {
      container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.add('drag-over');
        container.style.borderColor = 'rgba(102, 126, 234, 0.8)';
        container.style.background = 'rgba(102, 126, 234, 0.1)';
      });

      container.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.remove('drag-over');
        container.style.borderColor = '';
        container.style.background = '';
      });

      container.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.classList.remove('drag-over');
        container.style.borderColor = '';
        container.style.background = '';

        const files = e.dataTransfer.files;
        if (files.length === 0) return;

        const file = files[0];
        if (!file.type.startsWith('image/')) {
          this.showToast('请拖拽图片文件');
          return;
        }

        try {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            handleImageLoad(img, file.name);
            URL.revokeObjectURL(url);
            this.showToast('图片已加载: ' + file.name);
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            this.showToast('图片加载失败');
          };
          img.src = url;
        } catch (err) {
          console.error('[ComfyUI Panel] Drop failed:', err);
          this.showToast('拖拽加载失败');
        }
      });
    }

    async loadInputFileList(selectElement) {
      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/input_files?t=' + Date.now());
        const data = await response.json();

        if (data.success && data.files) {
          const currentValue = selectElement.value;

          selectElement.innerHTML = '<option value="">-- 选择文件 (' + data.count + ') --</option>';

          data.files.forEach(file => {
            const option = document.createElement('option');
            option.value = file.name;
            const sizeKB = Math.round(file.size / 1024);
            option.textContent = `${file.name} (${sizeKB}KB)`;
            selectElement.appendChild(option);
          });

          if (currentValue) {
            selectElement.value = currentValue;
          }
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Failed to load file list:', e);
        selectElement.innerHTML = '<option value="">-- 加载失败 --</option>';
      }
    }

    initCropBox(cropBox, imgEl, cropW, cropH, data) {
      const displayW = data.displayWidth || imgEl.clientWidth;
      const displayH = data.displayHeight || imgEl.clientHeight;
      const scale = data.scale || (displayW / data.width);
      const aspectRatio = cropW / cropH;
      let boxW, boxH;
      if (displayW / displayH > aspectRatio) { boxH = displayH * 0.8; boxW = boxH * aspectRatio; }
      else { boxW = displayW * 0.8; boxH = boxW / aspectRatio; }
      const boxX = (displayW - boxW) / 2, boxY = (displayH - boxH) / 2;
      cropBox.style.left = boxX + 'px';
      cropBox.style.top = boxY + 'px';
      cropBox.style.width = boxW + 'px';
      cropBox.style.height = boxH + 'px';
      // 存储原始图片坐标
      data.cropX = boxX / scale;
      data.cropY = boxY / scale;
      data.cropW = boxW / scale;
      data.cropH = boxH / scale;
      const cropInfo = cropBox.querySelector('.crop-info');
      if (cropInfo) cropInfo.textContent = `${Math.round(data.cropW)} × ${Math.round(data.cropH)}`;
    }

    updateCropBox(cropBox, imgEl, data, cropW, cropH) {
      const displayW = data.displayWidth || imgEl.clientWidth;
      const displayH = data.displayHeight || imgEl.clientHeight;
      const scale = data.scale || (displayW / data.width);
      const aspectRatio = cropW / cropH;
      const centerX = data.cropX + data.cropW / 2, centerY = data.cropY + data.cropH / 2;
      let boxW, boxH;
      if (data.cropW / data.cropH > aspectRatio) { boxH = data.cropH; boxW = boxH * aspectRatio; }
      else { boxW = data.cropW; boxH = boxW / aspectRatio; }
      let boxX = centerX - boxW / 2, boxY = centerY - boxH / 2;
      boxX = Math.max(0, Math.min(boxX, data.width - boxW));
      boxY = Math.max(0, Math.min(boxY, data.height - boxH));
      // 转换为显示坐标
      cropBox.style.left = (boxX * scale) + 'px';
      cropBox.style.top = (boxY * scale) + 'px';
      cropBox.style.width = (boxW * scale) + 'px';
      cropBox.style.height = (boxH * scale) + 'px';
      data.cropX = boxX; data.cropY = boxY; data.cropW = boxW; data.cropH = boxH;
      const cropInfo = cropBox.querySelector('.crop-info');
      if (cropInfo) cropInfo.textContent = `${Math.round(boxW)} × ${Math.round(boxH)}`;
    }

    maximizeCropBox(cropBox, imgEl, data, cropW, cropH) {
      const displayW = data.displayWidth || imgEl.clientWidth;
      const displayH = data.displayHeight || imgEl.clientHeight;
      const scale = data.scale || (displayW / data.width);
      const aspectRatio = cropW / cropH;
      let boxW, boxH;
      if (data.width / data.height > aspectRatio) { boxH = data.height; boxW = boxH * aspectRatio; }
      else { boxW = data.width; boxH = boxW / aspectRatio; }
      const boxX = (data.width - boxW) / 2, boxY = (data.height - boxH) / 2;
      // 转换为显示坐标
      cropBox.style.left = (boxX * scale) + 'px';
      cropBox.style.top = (boxY * scale) + 'px';
      cropBox.style.width = (boxW * scale) + 'px';
      cropBox.style.height = (boxH * scale) + 'px';
      data.cropX = boxX; data.cropY = boxY; data.cropW = boxW; data.cropH = boxH;
      const cropInfo = cropBox.querySelector('.crop-info');
      if (cropInfo) cropInfo.textContent = `${Math.round(boxW)} × ${Math.round(boxH)}`;
    }

    // 对所有图像加载卡片执行最大化操作
    maximizeAllImageCards() {
      const cropW = this.globalCropSize.width;
      const cropH = this.globalCropSize.height;

      // 遍历所有图像卡片数据
      Object.keys(this.imageCropData).forEach(key => {
        const cardData = this.imageCropData[key];
        if (!cardData) return;

        const data = cardData.getData();
        const cropSettings = cardData.cropSettings;
        const container = cardData.container;

        if (!data || !cropSettings || !container) return;

        // 获取裁剪框元素和图片元素
        const cropBox = container.querySelector('.crop-box');
        const imgEl = container.querySelector('.image-preview-wrapper img');
        if (!cropBox || !imgEl) return;

        // 更新显示尺寸
        const rect = imgEl.getBoundingClientRect();
        data.displayWidth = rect.width;
        data.displayHeight = rect.height;
        data.scale = rect.width / data.width;

        // 执行最大化
        this.maximizeCropBox(cropBox, imgEl, data, cropW, cropH);

        // 标记为需要上传
        this.markCropDirtyAndScheduleUpload(key);
      });
    }

    bindCropDrag(cropBox, imgEl, cropSettings, data, key) {
      let isDragging = false, isResizing = false, resizeHandle = null;
      let startX, startY, startLeft, startTop, startWidth, startHeight;

      const onMove = (e) => {
        if (!isDragging && !isResizing) return;
        const rect = imgEl.getBoundingClientRect();
        const dx = e.clientX - startX, dy = e.clientY - startY;
        const scale = data.scale || (rect.width / data.width);

        if (isDragging) {
          let newLeft = startLeft + dx, newTop = startTop + dy;
          newLeft = Math.max(0, Math.min(newLeft, rect.width - startWidth));
          newTop = Math.max(0, Math.min(newTop, rect.height - startHeight));
          cropBox.style.left = newLeft + 'px';
          cropBox.style.top = newTop + 'px';
          data.cropX = newLeft / scale;
          data.cropY = newTop / scale;
        } else if (isResizing) {
          const cropW = parseInt(cropSettings.querySelector('.crop-width').value) || 896;
          const cropH = parseInt(cropSettings.querySelector('.crop-height').value) || 1536;
          const aspectRatio = cropW / cropH;
          let newWidth, newHeight, newLeft, newTop;

          if (resizeHandle === 'se') { newWidth = startWidth + dx; newHeight = newWidth / aspectRatio; newLeft = startLeft; newTop = startTop; }
          else if (resizeHandle === 'sw') { newWidth = startWidth - dx; newHeight = newWidth / aspectRatio; newLeft = startLeft + (startWidth - newWidth); newTop = startTop; }
          else if (resizeHandle === 'ne') { newHeight = startHeight - dy; newWidth = newHeight * aspectRatio; newLeft = startLeft; newTop = startTop + (startHeight - newHeight); }
          else if (resizeHandle === 'nw') { newWidth = startWidth - dx; newHeight = newWidth / aspectRatio; newLeft = startLeft + (startWidth - newWidth); newTop = startTop + (startHeight - newHeight); }

          newWidth = Math.max(50, newWidth); newHeight = Math.max(50, newHeight);
          if (newLeft < 0) { newWidth = startLeft + startWidth; newHeight = newWidth / aspectRatio; newLeft = 0; }
          if (newTop < 0) { newHeight = startTop + startHeight; newWidth = newHeight * aspectRatio; newTop = 0; }
          if (newLeft + newWidth > rect.width) { newWidth = rect.width - newLeft; newHeight = newWidth / aspectRatio; }
          if (newTop + newHeight > rect.height) { newHeight = rect.height - newTop; newWidth = newHeight * aspectRatio; }

          cropBox.style.left = newLeft + 'px';
          cropBox.style.top = newTop + 'px';
          cropBox.style.width = newWidth + 'px';
          cropBox.style.height = newHeight + 'px';
          data.cropX = newLeft / scale;
          data.cropY = newTop / scale;
          data.cropW = newWidth / scale;
          data.cropH = newHeight / scale;
          const cropInfo = cropBox.querySelector('.crop-info');
          if (cropInfo) cropInfo.textContent = `${Math.round(data.cropW)} × ${Math.round(data.cropH)}`;
        }
      };

      const onUp = () => {
        if (isDragging || isResizing) {
          // 鼠标释放后，结束调整状态并开始1秒倒计时
          if (key) {
            this.endCropAdjust(key);
          }
        }
        isDragging = false;
        isResizing = false;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      cropBox.addEventListener('mousedown', (e) => {
        // 鼠标按下时，标记正在调整，暂停上传
        if (key) {
          this.startCropAdjust(key);
        }

        if (e.target.classList.contains('crop-resize-handle')) { isResizing = true; resizeHandle = e.target.className.split(' ').find(c => ['nw', 'ne', 'sw', 'se'].includes(c)); }
        else { isDragging = true; }
        startX = e.clientX; startY = e.clientY;
        startLeft = parseFloat(cropBox.style.left) || 0;
        startTop = parseFloat(cropBox.style.top) || 0;
        startWidth = parseFloat(cropBox.style.width) || 100;
        startHeight = parseFloat(cropBox.style.height) || 100;
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        e.preventDefault();
      });
    }

    renderSettingsNodes() { this.filterNodes(this.currentSearchQuery || ''); }

    filterNodes(query) {
      // 保存当前搜索查询
      this.currentSearchQuery = query;
      const container = this.elements.settingsNodes;
      container.innerHTML = '';
      const lowerQuery = query.toLowerCase();
      for (const node of this.parsedNodes) {
        if (node.inputs.length === 0) continue;
        if (query && !node.title.toLowerCase().includes(lowerQuery) && !node.classType.toLowerCase().includes(lowerQuery)) continue;
        const item = document.createElement('div');
        item.className = 'settings-node-item';
        const isActive = this.activeCards.includes(node.id);
        // 在节点名前面显示节点ID的数字
        item.innerHTML = `<div class="settings-node-info"><div class="settings-node-title"><span style="color: rgba(255,255,255,0.5); margin-right: 6px;">#${node.id}</span>${node.title}</div><div class="settings-node-type">${node.classType}</div></div><button class="panel-btn panel-btn-secondary panel-btn-icon">${isActive ? '-' : '+'}</button>`;
        item.querySelector('button').onclick = () => {
          if (this.activeCards.includes(node.id)) {
            this.removeCard(node.id);
          } else {
            if (this.currentTab) {
              // 只添加到 activeCards，避免重复添加
              this.activeCards.push(node.id);
              // 同步更新 currentTab.nodeIds（使用 activeCards 的引用）
              this.currentTab.nodeIds = this.activeCards;
              this.tabNodes[this.currentTab.id] = this.activeCards;
              this.renderConfigCards();
              // 保持过滤状态，不重置搜索
              this.filterNodes(this.currentSearchQuery || '');
            }
          }
        };
        container.appendChild(item);
      }
    }

    removeCard(nodeId) {
      this.activeCards = this.activeCards.filter(id => id !== nodeId);
      if (this.currentTab) {
        // 同步更新 currentTab.nodeIds（使用 activeCards 的引用）
        this.currentTab.nodeIds = this.activeCards;
        this.tabNodes[this.currentTab.id] = this.activeCards;
      }
      this.renderConfigCards();
      // 保持过滤状态
      this.filterNodes(this.currentSearchQuery || '');
    }

    collapseAllCards() {
      // 折叠随机种子面板
      this.elements.seedPanel.classList.add('collapsed');
      // 折叠所有配置卡片
      document.querySelectorAll('.config-card').forEach(card => {
        card.classList.add('collapsed');
        // 折叠时标题栏可拖拽排序
        const header = card.querySelector('.config-card-header');
        if (header) header.draggable = true;
      });
    }

    expandAllCards() {
      // 展开随机种子面板
      this.elements.seedPanel.classList.remove('collapsed');
      // 展开所有配置卡片
      document.querySelectorAll('.config-card').forEach(card => {
        card.classList.remove('collapsed');
        // 展开时标题栏不可拖拽排序（触发拖拽滑动）
        const header = card.querySelector('.config-card-header');
        if (header) header.draggable = false;
      });
    }

    toggleSettings() {
      // 如果当前活动面板是这个按钮，则返回卡片界面
      if (this.activePanelBtn === 'addCardBtn') {
        this.returnToCards();
        return;
      }
      
      // 打开设置面板
      this.setActivePanel('addCardBtn');
      this.hideAllPanels();
      this.elements.settingsPanel.classList.add('visible');
      this.elements.configContent.style.display = 'none';
    }

    async execute() {
      if (!this.workflow) { alert('请先加载工作流'); return; }
      const updatedWorkflow = deepClone(this.workflow);

      let usedSeedValue = null;
      if (this.seedEnabled && this.seedNode) {
        let seedValue = this.seedValue;
        if (seedValue === -1 || seedValue === "-1") {
          seedValue = await generateRandomSeed();
          this.lastGeneratedSeed = seedValue;
          this.updateSeedDisplay();
        }

        seedValue = String(seedValue);
        usedSeedValue = seedValue;

        const node = updatedWorkflow[this.seedNode];
        if (node && node.inputs) {
          if (node.class_type === 'RandomSeedNode') {
            if (node.inputs.hasOwnProperty('seed_str')) {
              node.inputs['seed_str'] = seedValue;
              this.cardValues[this.seedNode + '.seed_str'] = seedValue;
            }
          } else {
            let seedKey = null;
            for (const key of Object.keys(node.inputs)) {
              if (key.toLowerCase() === 'value' || key.toLowerCase().includes('seed')) {
                seedKey = key;
                break;
              }
            }

            if (seedKey) {
              node.inputs[seedKey] = seedValue;
              this.cardValues[this.seedNode + '.' + seedKey] = node.inputs[seedKey];
            }
          }
        }
      }

      // 收集所有需要上传的图片卡片（needsUpload === true）
      const uploadPromises = [];
      for (const [key, cropInfo] of Object.entries(this.imageCropData)) {
        if (cropInfo.needsUpload) {
          // 如果有正在进行的防抖定时器，先清除并立即执行上传
          if (cropInfo.uploadTimer) {
            clearTimeout(cropInfo.uploadTimer);
            cropInfo.uploadTimer = null;
          }
          uploadPromises.push(this.uploadCroppedImage(key));
        }
      }

      // 等待所有需要上传的图片上传完成（若有）
      if (uploadPromises.length > 0) {
        await Promise.all(uploadPromises);
      }

      // 将 cardValues 中的值应用到工作流
      for (const [key, value] of Object.entries(this.cardValues)) {
        // 图片裁剪卡片已经通过上传更新了 cardValues，直接应用即可
        const dotIndex = key.indexOf('.');
        const nodeId = key.substring(0, dotIndex);
        const inputKey = key.substring(dotIndex + 1);
        if (updatedWorkflow[nodeId]?.inputs) updatedWorkflow[nodeId].inputs[inputKey] = value;
      }

      // 应用上游节点连接设置
      console.log('[ComfyUI Panel] inputLinkSettings:', JSON.stringify(this.inputLinkSettings));
      console.log('[ComfyUI Panel] inputDisabledValues:', JSON.stringify(this.inputDisabledValues));
      for (const [key, settings] of Object.entries(this.inputLinkSettings)) {
        const dotIndex = key.indexOf('.');
        const nodeId = key.substring(0, dotIndex);
        const inputKey = key.substring(dotIndex + 1);
        
        console.log(`[ComfyUI Panel] Processing ${key}: enabled=${settings.enabled}, linkNodeId=${settings.linkNodeId}`);
        
        if (updatedWorkflow[nodeId]?.inputs) {
          if (settings.enabled === false) {
            // 禁用连接：使用替代值或null
            const disabledValue = this.inputDisabledValues[key];
            if (disabledValue && disabledValue.dataType !== 'null' && disabledValue.value !== undefined) {
              // 使用用户设置的替代值
              updatedWorkflow[nodeId].inputs[inputKey] = disabledValue.value;
              console.log(`[ComfyUI Panel] Disabled input link: ${nodeId}.${inputKey} -> ${disabledValue.value} (${disabledValue.dataType})`);
            } else {
              // 没有替代值，使用null
              updatedWorkflow[nodeId].inputs[inputKey] = null;
              console.log(`[ComfyUI Panel] Disabled input link: ${nodeId}.${inputKey} -> null`);
            }
          } else if (settings.enabled && settings.linkNodeId) {
            // 启用连接：设置上游连接
            updatedWorkflow[nodeId].inputs[inputKey] = [settings.linkNodeId, settings.linkOutputIndex];
            console.log(`[ComfyUI Panel] Applied input link: ${nodeId}.${inputKey} -> [${settings.linkNodeId}, ${settings.linkOutputIndex}]`);
          }
        }
      }
      
      // 打印最终工作流中的相关节点输入
      console.log('[ComfyUI Panel] Final workflow inputs for nodes with link settings:');
      for (const [key, settings] of Object.entries(this.inputLinkSettings)) {
        const dotIndex = key.indexOf('.');
        const nodeId = key.substring(0, dotIndex);
        const inputKey = key.substring(dotIndex + 1);
        if (updatedWorkflow[nodeId]?.inputs) {
          console.log(`  ${nodeId}.${inputKey}:`, updatedWorkflow[nodeId].inputs[inputKey]);
        }
      }

      this.isExecuting = true;
      this.elements.statusDot?.classList.add('executing');
      this.lastDownloadedFile = null;
      
      // 如果右侧面板隐藏，显示圆形进度指示器
      if (this.rightPanelHidden) {
        this.showCircularProgress();
      }

      if (this.previewUrl && this.previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(this.previewUrl);
        this.previewUrl = null;
      }
      this.generatedImages = [];

      this.completedOutputNodes = new Set();
      this.currentPromptId = null;

      try {
        const clientId = this.clientId || (typeof app !== 'undefined' && app.api ? app.api.clientId : '');

        const response = await fetch(this.baseUrl + '/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: updatedWorkflow,
            client_id: clientId
          })
        });

        const result = await response.json();

        if (result.error) {
          throw new Error(result.error.message || '执行失败');
        }

        if (result.prompt_id) {
          this.currentPromptId = result.prompt_id;
        }

        // 提交任务后立即检查队列状态
        this.checkQueueStatus();

      } catch (e) {
        console.error('[ComfyUI Panel] Execution failed:', e);
        alert('执行失败: ' + e.message);
        this.onExecutionComplete();
        this.checkQueueStatus();
      }
    }

    async interrupt() {
      try {
        await fetch(this.baseUrl + '/interrupt', { method: 'POST' });
        // 中断后检查队列状态
        this.checkQueueStatus();
      } catch (e) {
        console.error('[ComfyUI Panel] Interrupt failed:', e);
      }
    }

    async clearQueue() {
      try {
        // 先获取队列信息
        const queueResponse = await fetch(this.baseUrl + '/queue');
        if (!queueResponse.ok) {
          this.showToast('获取队列信息失败');
          return;
        }

        const queueData = await queueResponse.json();
        console.log('[ComfyUI Panel] Queue data:', queueData);

        // 获取队列中所有待处理任务的ID
        const queueRunning = queueData.queue_running || [];
        const queuePending = queueData.queue_pending || [];

        console.log('[ComfyUI Panel] Running:', queueRunning);
        console.log('[ComfyUI Panel] Pending:', queuePending);

        // 提取待处理任务的ID (prompt_id)
        // ComfyUI 队列格式: [数字序号, prompt_id(UUID), workflow, extra_data, outputs]
        const deleteIds = [];

        for (const item of queuePending) {
          if (Array.isArray(item) && item.length >= 2) {
            // 第二个元素是真正的 prompt_id (UUID格式)
            const promptId = item[1];
            if (promptId && typeof promptId === 'string') {
              deleteIds.push(promptId);
            }
          }
        }

        // 提取正在运行的任务ID（不删除）
        const runningIds = [];
        for (const item of queueRunning) {
          if (Array.isArray(item) && item.length >= 2) {
            const promptId = item[1];
            if (promptId && typeof promptId === 'string') {
              runningIds.push(promptId);
            }
          }
        }

        // 从待删除列表中排除正在运行的任务
        const idsToDelete = deleteIds.filter(id => !runningIds.includes(id));

        console.log('[ComfyUI Panel] Delete IDs (UUID):', idsToDelete);
        console.log('[ComfyUI Panel] Running IDs (excluded):', runningIds);

        if (idsToDelete.length === 0) {
          this.showToast('队列为空');
          return;
        }

        // 清空队列中的待处理任务
        const response = await fetch(this.baseUrl + '/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: idsToDelete })
        });

        console.log('[ComfyUI Panel] Clear queue response:', response.status);

        if (response.ok) {
          this.showToast(`已清空 ${idsToDelete.length} 个待处理任务`);
        } else {
          this.showToast('清空队列失败');
        }

        // 检查队列状态
        this.checkQueueStatus();
      } catch (e) {
        console.error('[ComfyUI Panel] Clear queue failed:', e);
        this.showToast('清空队列失败');
      }
    }

    // 重启 ComfyUI (需要安装 ComfyUI Manager 或 EasyUse)
    async rebootComfyUI() {
      if (!confirm('确定要重启 ComfyUI 吗？')) {
        return;
      }
      
      try {
        this.showToast('正在重启 ComfyUI...');
        
        // 尝试 EasyUse 的重启 API
        let response = await fetch(this.baseUrl + '/easyuse/reboot', {
          method: 'GET'
        });
        
        // 如果 EasyUse API 失败，尝试 ComfyUI Manager 的 API
        if (!response.ok) {
          response = await fetch(this.baseUrl + '/manager/reboot', {
            method: 'POST'
          });
        }
        
        if (response.ok) {
          this.showToast('ComfyUI 正在重启，请稍后刷新页面...');
          // 关闭 WebSocket 连接
          if (this.socket) {
            this.socket.close();
            this.socket = null;
          }
          // 更新连接状态
          this.isConnected = false;
          this.connectionStatus = 'disconnected';
          this.updateConnectionUI();
        } else {
          console.error('[ComfyUI Panel] Reboot failed:', response.status);
          this.showToast('重启失败：请确保已安装 EasyUse 或 ComfyUI Manager');
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Reboot failed:', e);
        this.showToast('重启失败：' + e.message);
      }
    }

    updateProgress(current, total) {
      this.lastProgress = { current, total };
      const percentage = total > 0 ? (current / total) * 100 : 0;
      this.elements.progressFill.style.width = percentage + '%';
      this.elements.progressText.textContent = `${current} / ${total}`;
      
      // 如果右侧面板隐藏，同时更新圆形进度指示器
      if (this.rightPanelHidden) {
        this.updateCircularProgress(current, total);
      }
    }

    onImagesGenerated(images, nodeId) {
      // console.log('[ComfyUI Panel] onImagesGenerated called, isVideoGeneration:', this.isVideoGeneration, 'images:', images?.length);
      
      // 如果是视频生成模式，不处理图片
      if (this.isVideoGeneration) {
        // console.log('[ComfyUI Panel] Skipping onImagesGenerated during video generation');
        return;
      }
      
      // 停止帧动画
      this.stopFrameAnimation();
      this.clearPreviewFrames();

      this.generatedImages = images;
      this.generatedVideos = [];  // 清空视频列表，确保下载时使用正确的类型
      if (images?.length > 0) {
        const image = images[0];
        const url = this.baseUrl + `/view?filename=${encodeURIComponent(image.filename)}&type=${image.type}&subfolder=${image.subfolder || ''}&t=${Date.now()}`;

        // 更新当前结果
        this.currentResult = {
          url: url,
          filename: image.filename,
          downloaded: false
        };

        // 清除过程预览标志，标记为最终结果
        this.isPreviewGenerating = false;

        // 重置下载记录，允许下载新结果
        this.lastDownloadedFile = null;

        // 隐藏视频帧信息
        this.elements.previewVideoInfo.classList.remove('visible');
        
        this.elements.previewPlaceholder.style.display = 'none';
        this.elements.previewVideo.style.display = 'none';
        this.elements.previewImage.src = url;
        this.elements.previewImage.style.display = 'block';
        this.updatePreviewBackground(url);
        this.resetPreviewZoom();
        
        // console.log('[ComfyUI Panel] Image displayed:', image.filename);
      }
    }

    onVideosGenerated(videos, nodeId) {
      // console.log('[ComfyUI Panel] ========== onVideosGenerated called ==========');
      // console.log('[ComfyUI Panel] videos:', videos);
      // console.log('[ComfyUI Panel] videos.length:', videos?.length);
      // console.log('[ComfyUI Panel] nodeId:', nodeId);
      
      // 停止帧动画
      this.stopFrameAnimation();
      
      // 重置视频生成状态
      this.isVideoGeneration = false;
      
      if (!videos || videos.length === 0) {
        // console.log('[ComfyUI Panel] No videos to display');
        return;
      }

      this.generatedVideos = videos;
      this.generatedImages = [];  // 清空图片列表，确保下载时使用正确的类型
      const video = videos[0];
      
      // console.log('[ComfyUI Panel] First video:', video);
      // console.log('[ComfyUI Panel] video.filename:', video.filename);
      // console.log('[ComfyUI Panel] video.type:', video.type);
      // console.log('[ComfyUI Panel] video.subfolder:', video.subfolder);
      
      const url = this.baseUrl + `/view?filename=${encodeURIComponent(video.filename)}&type=${video.type || 'output'}&subfolder=${video.subfolder || ''}&t=${Date.now()}`;

      // console.log('[ComfyUI Panel] Video URL:', url);
      // console.log('[ComfyUI Panel] baseUrl:', this.baseUrl);

      // 更新当前结果
      this.currentResult = {
        url: url,
        filename: video.filename,
        downloaded: false,
        isVideo: true
      };

      // 清除过程预览标志
      this.isPreviewGenerating = false;
      this.isVideoPreview = true;

      // 重置下载记录
      this.lastDownloadedFile = null;

      // 隐藏视频帧信息
      this.elements.previewVideoInfo.classList.remove('visible');

      // 隐藏图片，显示视频
      this.elements.previewImage.style.display = 'none';
      this.elements.previewPlaceholder.style.display = 'none';
      
      // 设置视频源
      console.log('[ComfyUI Panel] Setting video src...');
      this.elements.previewVideo.src = url;
      this.elements.previewVideo.style.display = 'block';
      
      console.log('[ComfyUI Panel] Video element:', this.elements.previewVideo);
      console.log('[ComfyUI Panel] Video element display:', this.elements.previewVideo.style.display);
      
      // 监听视频加载事件
      this.elements.previewVideo.onloadstart = () => {
        console.log('[ComfyUI Panel] Video load started');
      };
      
      this.elements.previewVideo.onloadedmetadata = () => {
        console.log('[ComfyUI Panel] Video metadata loaded');
      };
      
      this.elements.previewVideo.onloadeddata = () => {
        console.log('[ComfyUI Panel] Video data loaded, attempting to play...');
        this.elements.previewVideo.play().then(() => {
          console.log('[ComfyUI Panel] Video playing successfully');
        }).catch(e => {
          console.log('[ComfyUI Panel] Video autoplay failed:', e);
        });
      };
      
      this.elements.previewVideo.oncanplay = () => {
        console.log('[ComfyUI Panel] Video can play');
      };
      
      this.elements.previewVideo.onerror = (e) => {
        console.error('[ComfyUI Panel] Video load error:', e);
        console.error('[ComfyUI Panel] Video error code:', this.elements.previewVideo.error?.code);
        console.error('[ComfyUI Panel] Video error message:', this.elements.previewVideo.error?.message);
        this.showToast('视频加载失败: ' + (this.elements.previewVideo.error?.message || '未知错误'));
      };
      
      // 加载视频
      this.elements.previewVideo.load();
      
      console.log('[ComfyUI Panel] ========== onVideosGenerated done ==========');
    }

    updatePreviousResultThumb() {
      if (!this.previousResult) {
        this.elements.previousResultThumb.style.display = 'none';
        return;
      }

      this.elements.thumbImage.src = this.previousResult.url;
      this.elements.previousResultThumb.style.display = 'flex';
      
      // 更新下载状态样式
      if (this.previousResult.downloaded) {
        this.elements.previousResultThumb.classList.add('downloaded');
      } else {
        this.elements.previousResultThumb.classList.remove('downloaded');
      }
    }

    async downloadPreviousResult() {
      if (!this.previousResult) return;

      try {
        const url = this.previousResult.url;
        const filename = this.previousResult.filename;

        const response = await fetch(url);
        const blob = await response.blob();

        // 如果已下载，复制到剪贴板
        if (this.previousResult.downloaded) {
          // 转换为 PNG 格式以确保剪贴板兼容性
          const pngBlob = await this.convertToPNG(blob);
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          this.showToast('已复制到剪贴板');
          return;
        }

        // 否则下载
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(blobUrl);

        // 标记为已下载
        this.previousResult.downloaded = true;
        this.updatePreviousResultThumb();
      } catch (e) {
        console.error('[ComfyUI Panel] Download previous result failed:', e);
        this.showToast('操作失败: ' + e.message);
      }
    }

    onExecutionComplete() {
      console.log('[ComfyUI Panel] onExecutionComplete called');
      this.isExecuting = false;
      this.elements.statusDot?.classList.remove('executing');
      // 重置视频帧计数
      this.videoTotalFrames = 0;
      this.videoCurrentFrame = 0;
      // 重置视频生成状态
      this.isVideoGeneration = false;
      // 隐藏圆形进度指示器
      this.hideCircularProgress();
      // 注意：不要在这里停止帧动画，因为可能需要继续播放预览
      // 如果有视频或图片结果，它们会各自处理
    }

    onExecutionError(error) { alert('执行错误: ' + (error.exception_message || error.message || '未知错误')); this.onExecutionComplete(); }

    async saveConfig() {
      const config = this.getConfig();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'comfyui_panel_config.json';
      a.click();
      URL.revokeObjectURL(url);
      this.showToast('配置已下载到本地');

      await this.saveConfigToServer(config);
    }

    // 静默保存到服务器（不下载、不弹提示）
    async saveConfigSilent() {
      const config = this.getConfig();
      await this.saveConfigToServer(config, true);
    }

    // 保存配置到服务器
    async saveConfigToServer(config, silent = false) {
      const select = this.elements.serverConfigSelect;
      let filename = select.value;
      
      // 如果没有选中的配置，弹出输入框（静默模式不弹）
      if (!filename) {
        if (silent) {
          console.log('[ComfyUI Panel] No config selected, skip silent save');
          return;
        }
        filename = prompt('请输入要保存到服务器的文件名（不包含扩展名）', 'my_config');
        if (!filename) return;
        filename = filename + '.json';
      }
      // 有选中的配置，直接覆盖，不弹提示

      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/save_config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: filename,
            config: config
          })
        });
        const result = await response.json();
        if (result.success) {
          if (!silent) {
            this.showToast(`配置已保存到服务器: ${result.filename}`);
          }
          // 刷新配置列表
          await this.loadServerConfigList();
          // 选定保存的配置
          select.value = result.filename;
          // 保存为上次使用的配置
          this.saveLastUsedConfig(result.filename);
        } else {
          if (!silent) {
            alert('保存到服务器失败: ' + result.error);
          }
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Save to server failed:', e);
        if (!silent) {
          alert('保存到服务器失败: ' + e.message);
        }
      }
    }

    // 另存为功能
    async saveConfigAs() {
      const config = this.getConfig();
      const select = this.elements.serverConfigSelect;
      
      // 获取默认文件名（当前选中的配置名或空）
      const defaultName = select.value ? select.value.replace('.json', '') : 'my_config';
      
      let filename = prompt('请输入新的文件名（不包含扩展名）', defaultName);
      if (!filename) return;
      filename = filename + '.json';

      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/save_config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: filename,
            config: config
          })
        });
        const result = await response.json();
        if (result.success) {
          this.showToast(`配置已另存为: ${result.filename}`);
          // 刷新配置列表
          await this.loadServerConfigList();
          // 选定保存的配置
          select.value = result.filename;
          // 保存为上次使用的配置
          this.saveLastUsedConfig(result.filename);
        } else {
          alert('保存到服务器失败: ' + result.error);
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Save as failed:', e);
        alert('保存到服务器失败: ' + e.message);
      }
    }

    // 保存上次使用的配置文件名
    async saveLastUsedConfig(filename) {
      try {
        await fetch(this.baseUrl + '/comfyui_panel/save_config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: '.last_used_config.json',
            config: { lastUsedConfig: filename, timestamp: Date.now() }
          })
        });
      } catch (e) {
        console.error('[ComfyUI Panel] Save last used config failed:', e);
      }
    }

    // 加载上次使用的配置文件名
    async loadLastUsedConfig() {
      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/load_config?name=.last_used_config.json');
        const data = await response.json();
        if (data.success && data.config && data.config.lastUsedConfig) {
          return data.config.lastUsedConfig;
        }
      } catch (e) {
        // 文件不存在或其他错误，忽略
      }
      return null;
    }

    async loadServerConfigList() {
      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/list_configs');
        const data = await response.json();
        if (data.success) {
          const select = this.elements.serverConfigSelect;
          select.innerHTML = '<option value="">-- 选择配置 --</option>';
          
          // 排除提示词库配置文件和隐藏文件
          const promptLibraryFilename = this.getPromptLibraryFilename();
          const filteredFiles = data.files.filter(file => 
            file.name !== promptLibraryFilename && 
            !file.name.startsWith('.')
          );
          
          // 按修改时间排序（最新的在前）
          filteredFiles.sort((a, b) => {
            const timeA = new Date(a.modified || 0).getTime();
            const timeB = new Date(b.modified || 0).getTime();
            return timeB - timeA;
          });
          
          filteredFiles.forEach(file => {
            const option = document.createElement('option');
            option.value = file.name;
            option.textContent = file.display;
            select.appendChild(option);
          });
          
          // 返回排序后的文件列表，供自动加载使用
          return filteredFiles;
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Error loading server config list:', e);
      }
      return [];
    }

    // 自动加载上次使用的配置文件
    async autoLoadLastConfig() {
      try {
        // 先加载配置列表
        const files = await this.loadServerConfigList();
        if (!files || files.length === 0) {
          // 没有配置文件，加载提示词库后返回
          this.loadPromptLibraryConfig();
          return false;
        }

        // 尝试加载上次使用的配置
        const lastUsedFilename = await this.loadLastUsedConfig();
        let configToLoad = null;

        if (lastUsedFilename) {
          // 检查上次使用的配置是否还在列表中
          const exists = files.some(f => f.name === lastUsedFilename);
          if (exists) {
            configToLoad = lastUsedFilename;
          }
        }

        // 如果没有上次使用的配置，使用最新修改的配置
        if (!configToLoad) {
          configToLoad = files[0].name;
        }

        console.log('[ComfyUI Panel] Auto loading config:', configToLoad);

        const response = await fetch(this.baseUrl + '/comfyui_panel/load_config?name=' + encodeURIComponent(configToLoad));
        const data = await response.json();
        if (data.success) {
          this.elements.serverConfigSelect.value = configToLoad;
          this.applyConfig(data.config);
          this.showToast(`已自动加载: ${configToLoad}`);
          // 更新上次使用的配置记录
          this.saveLastUsedConfig(configToLoad);
          // 加载提示词库
          this.loadPromptLibraryConfig();
          return true;
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Auto load last config failed:', e);
      }
      // 无论是否加载了配置，都加载提示词库
      this.loadPromptLibraryConfig();
      return false;
    }

    async loadServerConfig() {
      const select = this.elements.serverConfigSelect;
      const filename = select.value;
      if (!filename) {
        alert('请先选择一个配置');
        return;
      }

      try {
        const response = await fetch(this.baseUrl + '/comfyui_panel/load_config?name=' + encodeURIComponent(filename));
        const data = await response.json();
        if (data.success) {
          this.applyConfig(data.config);
          this.showToast(`已加载配置: ${filename}`);
          // 保存为上次使用的配置
          this.saveLastUsedConfig(filename);
          // 同时加载提示词库配置
          this.loadPromptLibraryConfig();
        } else {
          alert('加载失败: ' + data.error);
        }
      } catch (e) {
        console.error('[ComfyUI Panel] Load server config failed:', e);
        alert('加载失败: ' + e.message);
      }
    }

    loadConfigDialog() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const config = JSON.parse(ev.target.result);
            this.applyConfig(config);
            this.saveToLocalStorage();
            // 清除服务器配置列表选项，避免点保存覆盖原配置
            this.elements.serverConfigSelect.value = '';
            this.showToast('配置已加载');
          } catch (err) { alert('无法解析配置文件'); }
        };
        reader.readAsText(file);
      };
      input.click();
    }

    getConfig() {
      document.querySelectorAll('.form-textarea').forEach(textarea => {
        const key = textarea.dataset.key;
        if (key && textarea.style.height) {
          this.textareaHeights[key] = textarea.style.height;
        }
      });

      return {
        workflow: this.workflow,
        tabs: this.tabs,
        currentTab: this.currentTab?.id || null,
        tabNodes: this.tabNodes,
        cardValues: this.cardValues,
        globalCropSize: this.globalCropSize,
        linkCropSize: this.linkCropSize,
        seedNode: this.seedNode,
        seedValue: this.seedValue,
        seedEnabled: this.seedEnabled,
        textareaHeights: this.textareaHeights,
        theme: this.theme,
        // 提示词库设置
        promptLibraryDarkMode: this.promptLibraryDarkMode,
        highlightColorA: this.highlightColorA,
        highlightColorB: this.highlightColorB,
        editorBgColorDark: this.editorBgColorDark,
        editorBgColorLight: this.editorBgColorLight,
        // 上游节点连接设置
        inputLinkSettings: this.inputLinkSettings,
        // 卡片级别的连接显示开关状态
        cardLinkToggleState: this.cardLinkToggleState,
        // 输入项的默认值类型配置
        inputDefaultConfig: this.inputDefaultConfig,
        // 禁用连接时的替代值设置
        inputDisabledValues: this.inputDisabledValues,
        // 保存本地输出设置
        localOutputConfigs: this.getLocalOutputConfigs()
      };
    }

    getLocalOutputConfigs() {
      const configs = {};
      for (const [key, data] of Object.entries(this.imageCropData)) {
        if (data.getLocalOutputConfig) {
          const config = data.getLocalOutputConfig();
          if (config.enabled || config.directory) {
            configs[key] = config;
          }
        }
      }
      return configs;
    }

    saveToLocalStorage() {
      try {
        const config = this.getConfig();
        localStorage.setItem('comfyui_panel_config', JSON.stringify(config));
      } catch (e) {
        console.warn('[ComfyUI Panel] Failed to save to localStorage:', e);
      }
    }

    loadFromLocalStorage() {
      try {
        const saved = localStorage.getItem('comfyui_panel_config');
        if (saved) {
          const config = JSON.parse(saved);
          this.applyConfig(config);
          return true;
        }
      } catch (e) {
        console.warn('[ComfyUI Panel] Failed to load from localStorage:', e);
      }
      return false;
    }

    showToast(message, duration = 2000) {
      const toast = document.createElement('div');
      toast.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(102, 126, 234, 0.9); color: white;
        padding: 10px 20px; border-radius: 6px; font-size: 14px;
        z-index: 10001; animation: fadeInOut ${duration}ms ease;
      `;
      toast.textContent = message;

      if (!document.getElementById('toast-animation-style')) {
        const style = document.createElement('style');
        style.id = 'toast-animation-style';
        style.textContent = `
          @keyframes fadeInOut {
            0% { opacity: 0; transform: translateX(-50%) translateY(10px); }
            15% { opacity: 1; transform: translateX(-50%) translateY(0); }
            85% { opacity: 1; transform: translateX(-50%) translateY(0); }
            100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
          }
        `;
        document.head.appendChild(style);
      }

      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), duration);
    }

    applyConfig(config) {
      // 先加载工作流
      if (config.workflow) {
        this.setWorkflow(config.workflow);
      }

      // 恢复卡片值（必须在工作流加载后，因为卡片渲染需要工作流数据）
      if (config.cardValues) {
        // 规范化所有值，处理可能存在的 __value__ 格式错误数据
        const normalizedCardValues = {};
        for (const [key, value] of Object.entries(config.cardValues)) {
          normalizedCardValues[key] = normalizeValue(value);
        }
        this.cardValues = { ...this.cardValues, ...normalizedCardValues };
      }

      // 恢复标签页结构
      if (config.tabs && config.tabs.length > 0) {
        // 验证标签页中的节点ID是否存在于当前工作流中
        const validNodeIds = new Set(this.parsedNodes.map(n => n.id));
        this.tabs = config.tabs.map(tab => {
          const nodeIds = (tab.nodeIds || []).filter(id => validNodeIds.has(id));
          return {
            ...tab,
            nodeIds: nodeIds
          };
        });
        
        // 确保 tabNodes 和 tabs 中的 nodeIds 是同一个引用
        this.tabs.forEach(tab => {
          this.tabNodes[tab.id] = tab.nodeIds;
        });
        
        // 重新渲染标签页
        this.renderTabs();
        
        // 激活保存的标签
        if (config.currentTab) {
          const tab = this.tabs.find(t => t.id === config.currentTab);
          if (tab) {
            this.switchTab(tab.id);
          } else if (this.tabs.length > 0) {
            this.switchTab(this.tabs[0].id);
          }
        } else if (this.tabs.length > 0) {
          this.switchTab(this.tabs[0].id);
        }
      } else {
        // 没有保存标签则创建默认主标签
        this.resetTabsFromWorkflow();
      }

      // 恢复其他设置
      if (config.globalCropSize) this.globalCropSize = config.globalCropSize;
      if (config.linkCropSize !== undefined) this.linkCropSize = config.linkCropSize;
      if (config.seedNode !== undefined) { 
        this.seedNode = config.seedNode; 
        this.elements.seedNodeSelect.value = config.seedNode; 
      }
      if (config.seedValue !== undefined) { 
        this.seedValue = config.seedValue; 
        this.elements.seedValue.value = config.seedValue; 
      }
      if (config.seedEnabled !== undefined) { 
        this.seedEnabled = config.seedEnabled; 
        this.elements.seedEnabled.checked = config.seedEnabled; 
      }
      if (config.textareaHeights) this.textareaHeights = { ...this.textareaHeights, ...config.textareaHeights };
      if (config.theme) {
        this.theme = config.theme;
        this.updateThemeStyles();
      }

      // 恢复提示词库设置
      if (config.promptLibraryDarkMode !== undefined) {
        this.promptLibraryDarkMode = config.promptLibraryDarkMode;
      }
      if (config.highlightColorA) {
        this.highlightColorA = config.highlightColorA;
        if (this.elements.highlightColorA) {
          this.elements.highlightColorA.value = config.highlightColorA;
        }
      }
      if (config.highlightColorB) {
        this.highlightColorB = config.highlightColorB;
        if (this.elements.highlightColorB) {
          this.elements.highlightColorB.value = config.highlightColorB;
        }
      }
      // 加载编辑框背景色（支持新旧配置格式）
      if (config.editorBgColorDark) {
        this.editorBgColorDark = config.editorBgColorDark;
      }
      if (config.editorBgColorLight) {
        this.editorBgColorLight = config.editorBgColorLight;
      }
      // 兼容旧配置格式
      if (config.editorBgColor && !config.editorBgColorDark && !config.editorBgColorLight) {
        // 旧配置只有一个颜色，根据当前模式设置
        if (this.promptLibraryDarkMode) {
          this.editorBgColorDark = config.editorBgColor;
        } else {
          this.editorBgColorLight = config.editorBgColor;
        }
      }
      // 应用提示词库主题
      this.applyPromptLibraryTheme();

      // 最后渲染卡片（这样cardValues已经正确恢复）
      if (this.currentTab) {
        // 确保 activeCards 和 currentTab.nodeIds 是同一个引用
        this.activeCards = this.currentTab.nodeIds;
        this.renderConfigCards();
      }
      this.renderSettingsNodes();

      // 重置所有图片卡片的脏标记为 false（因为加载的配置已经是保存时的状态，无需上传）
      for (const key in this.imageCropData) {
        if (this.imageCropData.hasOwnProperty(key)) {
          this.imageCropData[key].needsUpload = false;
        }
      }

      // 恢复上游节点连接设置
      if (config.inputLinkSettings) {
        this.inputLinkSettings = { ...config.inputLinkSettings };
      }

      // 恢复卡片级别的连接显示开关状态
      if (config.cardLinkToggleState) {
        this.cardLinkToggleState = { ...config.cardLinkToggleState };
      }

      // 恢复输入项的默认值类型配置
      if (config.inputDefaultConfig) {
        this.inputDefaultConfig = { ...config.inputDefaultConfig };
      }

      // 恢复禁用连接时的替代值设置
      if (config.inputDisabledValues) {
        this.inputDisabledValues = { ...config.inputDisabledValues };
      }

      // 恢复本地输出设置
      if (config.localOutputConfigs) {
        for (const [key, localConfig] of Object.entries(config.localOutputConfigs)) {
          if (this.imageCropData[key] && this.imageCropData[key].setLocalOutputConfig) {
            this.imageCropData[key].setLocalOutputConfig(localConfig);
          }
        }
      }
    }

    updateThemeStyles() {
      const style = document.querySelector('#comfyui-panel-styles');
      if (!style) return;
      
      let cssText = style.textContent;
      cssText = cssText.replace(/background:\s*linear-gradient\(135deg,\s*#[a-zA-Z0-9]+\s*0%,\s*#[a-zA-Z0-9]+\s*100%\)/g, `background: ${this.theme.primaryGradient}`);
      cssText = cssText.replace(/background:\s*linear-gradient\(135deg,\s*#[a-zA-Z0-9]+\s*0%,\s*#[a-zA-Z0-9]+\s*50%,\s*#[a-zA-Z0-9]+\s*100%\)/g, `background: ${this.theme.backgroundColor}`);
      cssText = cssText.replace(/background:\s*rgba\(255,\s*255,\s*255,\s*0\.04\)/g, `background: ${this.theme.cardBackground}`);
      cssText = cssText.replace(/border:\s*1px\s*solid\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/g, `border: 1px solid ${this.theme.borderStyle}`);
      cssText = cssText.replace(/background:\s*#667eea/g, this.theme.accentColor);
      cssText = cssText.replace(/color:\s*white/g, this.theme.textColor);
      cssText = cssText.replace(/color:\s*rgba\(255,\s*255,\s*255,\s*0\.6\)/g, this.theme.placeholderColor);
      
      style.textContent = cssText;
    }

    async loadConfig() {
      // 先尝试自动加载服务器上最后修改的配置文件
      const serverLoaded = await this.autoLoadLastConfig();
      // 如果服务器配置加载失败，再尝试从本地存储加载
      if (!serverLoaded) {
        this.loadFromLocalStorage();
      }
    }
  }

  function init() { console.log('[ComfyUI Panel] Initializing...'); window.comfyUIPanel = new ComfyUIPanel(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else setTimeout(init, 100);
})();