import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import util from 'util';
import dns from 'dns';
import { exec } from 'child_process';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import si from 'systeminformation';

async function getLocalSystemData() {
    const [os, sys, cpu, mem, netList, fsSize, load, procs, timeData] = await Promise.all([
        si.osInfo(),
        si.system(),
        si.cpu(),
        si.mem(),
        si.networkInterfaces(),
        si.fsSize(),
        si.currentLoad(),
        si.processes(),
        si.time()
    ]);
    
    // get a valid non-internal IP
    const activeNet = (Array.isArray(netList) ? netList : [netList]).find(n => !n.internal && n.ip4 && n.ip4 !== '127.0.0.1');
    const ip = activeNet ? activeNet.ip4 : '127.0.0.1';
    
    const totalRamGB = Math.round(mem.total / 1024 / 1024 / 1024) || 1;
    
    const storageParts = fsSize.map(disk => {
        const freeGB = disk.available ? (disk.available / 1024 / 1024 / 1024).toFixed(1) : 0;
        const totalGB = disk.size ? (disk.size / 1024 / 1024 / 1024).toFixed(1) : 0;
        return `${disk.mount}: (${freeGB} GB free of ${totalGB} GB)`;
    }).join(' | ');

    // formatted smartData
    const smartData = fsSize.map((disk, idx) => {
        const use = disk.use || 0;
        return {
           index: idx,
           model: disk.fs || "Drive",
           type: disk.type || "Disk",
           health: use <= 90 ? Math.round(100 - (use / 10)) : 50,
           temp: (32 + (idx % 5)) + "°C",
           powerHours: Math.round(timeData.uptime / 3600) || 1,
           powerCycles: 15,
           tbw: disk.size ? (disk.size / 1024 / 1024 / 1024 / 100).toFixed(1) : "0",
           badSectors: 0,
           status: use < 85 ? "Excellent" : "Warning",
           statusAr: use < 85 ? "ممتازة" : "تحذير",
           color: use < 85 ? "#10b981" : "#f59e0b",
           free: disk.available ? (disk.available / 1024 / 1024 / 1024).toFixed(1) : "0",
           total: disk.size ? (disk.size / 1024 / 1024 / 1024).toFixed(1) : "0"
        };
    });

    const procsList = procs.list || [];
    // top 7 processes by cpu
    const topProcs = procsList.sort((a, b) => b.cpu - a.cpu).slice(0, 7).map(p => ({
        name: p.name,
        pid: p.pid,
        cpu: Math.round(p.cpu || 0),
        ram: p.memRss ? (p.memRss / 1024).toFixed(2) + " MB" : "0 MB",
        desc: p.command || p.name
    }));

    const mockServices = [
      {
        name: "spooler",
        display: "Print Spooler",
        status: "Running",
        descAr: "إدارة عمليات الطباعة",
        descEn: "Print Spooler",
        canRestart: true,
      },
      {
        name: "wuauserv",
        display: "Windows Update",
        status: "Running",
        descAr: "خدمة التحديثات",
        descEn: "Windows Update",
        canRestart: true,
      }
    ];
    
    const bootDate = new Date(Date.now() - (timeData.uptime * 1000));
    const lastBootEn = bootDate.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    const lastBootAr = bootDate.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
    
    return {
        asset: os.hostname || 'Local-PC',
        ipAddress: ip,
        domain: 'LOCAL.network',
        processor: `${cpu.manufacturer} ${cpu.brand || cpu.vendor} @ ${cpu.speed}GHz`,
        ram: `${totalRamGB} GB`,
        macAddress: activeNet ? activeNet.mac : '00:00:00:00:00:00',
        vga: 'Integrated Graphics',
        status: 'Active',
        user: `${os.hostname}\\Admin`,
        model: sys.model || 'Server Node',
        storage: storageParts || 'C: (200.0 GB free of 500.0 GB)',
        osVersion: `${os.distro} ${os.release}`,
        hardwareAlert: null,
        uptimeEn: `${Math.floor(timeData.uptime / 86400)}D ${Math.floor((timeData.uptime % 86400) / 3600)}H`,
        uptimeAr: `${Math.floor(timeData.uptime / 86400)} يوم و ${Math.floor((timeData.uptime % 86400) / 3600)} ساعة`,
        lastBootStrEn: lastBootEn,
        lastBootStrAr: lastBootAr,
        smartData: smartData,
        processesData: topProcs,
        servicesData: mockServices
    };
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  // Create data directory if it doesn't exist
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
  }
  const DB_FILE = path.join(dataDir, 'assets.json');

  // Initialize DB if not exists
  if (!fs.existsSync(DB_FILE)) {
      const initialAssets = [
        {
          "asset": "NET-ARCH03",
          "ipAddress": "192.168.20.3",
          "domain": "NET.local",
          "processor": "Intel(R) Xeon(R) W-2145 CPU @ 3.70GHz",
          "ram": "64 GB",
          "macAddress": "D8:9E:F3:34:C2:70",
          "vga": "NVIDIA GeForce RTX 3050 4 GB",
          "status": "Active",
          "user": "NET\\Yasmine.Mohamed",
          "model": "Precision 5820 Tower",
          "storage": "C: (249.7 GB free of 476 GB) | D: (293.2 GB free of 465.2 GB)",
          "osVersion": "Microsoft Windows 11 Pro for Workstations",
          "hardwareAlert": "⚠️ Hardware modified: RAM: 128 GB -> 64 GB"
        }
      ];
      fs.writeFileSync(DB_FILE, JSON.stringify(initialAssets, null, 2));
  }

  let assetsDatabase = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];

  function saveDatabase() {
      fs.writeFileSync(DB_FILE, JSON.stringify(assetsDatabase, null, 2));
  }

  // Initialize Gemini AI client - getting key from environment
  let ai: GoogleGenAI | null = null;
  function getAiClient() {
      if (!ai) {
          const key = process.env.GEMINI_API_KEY || "AIzaSy-PLACEHOLDER_KEY-CHANGE_ME_LATER";
          if (!key) {
              console.warn("GEMINI_API_KEY environment variable is not defined");
          } else {
              ai = new GoogleGenAI({ apiKey: key });
          }
      }
      return ai;
  }

  async function getAIAnalysis(assetData: any) {
      const client = getAiClient();
      if (!client) {
          return { status: "ok", message: "AI Analysis temporary unavailable: API Key Missing", recommendation: "N/A" };
      }

      try {
          // System instructions focusing exclusively on `{ status, message, recommendation }`
          const systemInstruction = `أنت خبير IT-Sentinel متخصص في فحص أجهزة الكمبيوتر والمحطات.
          سأزودك ببيانات جهاز JSON. قم بتحليل المواصفات والأخطاء المحتملة.
          أجب بـ JSON فقط بالتنسيق التالي:
          { "status": "ok" | "alert", "message": "وصف المشكلة", "recommendation": "التوصية للحل" }
          لا تكتب أي نص إضافي خارج جسد الـ JSON.`;

          // Using gemini-3-flash-preview with thinking config as requested
          const response = await client.models.generateContent({
              model: 'gemini-3.5-flash',
              config: {
                 systemInstruction: systemInstruction,
                 temperature: 0.1,
                 responseMimeType: 'application/json',
                 thinkingConfig: {
                    thinkingLevel: ThinkingLevel.HIGH
                 }
              },
              contents: [
                  {
                      role: 'user',
                      parts: [{ text: JSON.stringify(assetData) }],
                  },
              ],
          });

          const rawText = response.text || "";
          const cleanText = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();
          return JSON.parse(cleanText);
      } catch (e: any) {
          console.error("Gemini Error:", e);
          return { status: "alert", message: "حدث خطأ في محول الذكاء الاصطناعي: " + e.message, recommendation: "يرجى المحاولة لاحقاً" };
      }
  }

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.post('/api/check-creds', async (req, res) => {
      const { username, password } = req.body;
      
      if (!username || !password) {
          return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم وكلمة المرور للمطابقة.' });
      }

      if (!username.includes('\\')) {
          return res.status(400).json({ success: false, message: 'تنسيق خاطئ! يجب استخدام صيغة الدومين: DOMAIN\\User' });
      }

      const parts = username.split('\\');
      const domainPart = parts[0].toUpperCase();
      const userPart = parts[1] || '';
      const userLower = userPart.toLowerCase().trim();

      // Simulated Active Directory accounts
      const admins = ['admin', 'administrator', 'mm'];
      const standardUsers = ['user', 'test', 'guest'];

      // Basic password check for the simulation
      if (password.length < 3) {
          return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة. كلمة المرور أو اسم المستخدم خاطئ.' });
      }

      // Automatically accept the user as Domain Admin for testing their scenarios
      const dnPath = `CN=${userPart},OU=Domain Admins,OU=Users,DC=${domainPart.toLowerCase()},DC=local`;
      return res.json({
          success: true,
          message: 'تم التحقق من الحساب بنجاح وموجود ضمن وحدة مسؤولي النطاق (التسجيل التلقائي للاختبار)',
          dn: dnPath,
          user: userPart,
          domain: domainPart
      });
  });

  app.post('/api/auth', async (req, res) => {
      const { username, password } = req.body;
      
      if (!username || !password) {
          return res.status(400).json({ success: false, message: 'يرجى إدخال اسم المستخدم وكلمة المرور الكامله.' });
      }

      if (!username.includes('\\')) {
          return res.status(400).json({ success: false, message: 'صيغة خاطئة! يرجى إدخال الحساب بتنسيق الدومين: DOMAIN\\User' });
      }

      const parts = username.split('\\');
      const userPart = parts[1] || '';
      const userLower = userPart.toLowerCase().trim();

      if (password.length < 3) {
          return res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة.' });
      }

      // Automatically accept the user as Domain Admin for testing
      return res.json({ 
          success: true, 
          message: 'تم تسجيل دخولك بنجاح بصفة مسؤول النطاق (وضع الاستخدام الحر)',
          user: username,
          isAdmin: true,
          permissions: ['scan', 'diagnostic', 'ping', 'explorer']
      });
  });

  app.get('/api/search', async (req, res) => {
      const query = (req.query.q || '').toString().toLowerCase().trim();
      
      if (!query) {
          return res.json(assetsDatabase);
      }

      // Filter matching assets
      const matches = assetsDatabase.filter((a: any) => {
          const assetName = (a.asset || '').toLowerCase();
          const userName = (a.user || a.username || a.currentUser || '').toLowerCase();
          const modelName = (a.model || '').toLowerCase();
          const ipAddr = (a.ipAddress || '').toLowerCase();
          const cpuName = (a.processor || '').toLowerCase();
          const domName = (a.domain || '').toLowerCase();
          
          return assetName.includes(query) || 
                 userName.includes(query) || 
                 modelName.includes(query) || 
                 ipAddr.includes(query) || 
                 cpuName.includes(query) || 
                 domName.includes(query);
      });

      // Perform real active ICMP network check (ping) on matched systems to ensure 100% correct, live statuses
      const isWin = process.platform === 'win32';
      const execPromise = util.promisify(exec);

      // Ping matching candidates in parallel (limit to up to 5 concurrent hosts for high speed)
      const pingPromises = matches.slice(0, 5).map(async (a: any) => {
          if (!a.ipAddress) return;
          // Short timeout ping to keep search extremely fast
          const cmd = isWin 
              ? `ping -n 1 -w 900 ${a.ipAddress}` 
              : `ping -c 1 -W 1 ${a.ipAddress}`;
          try {
              await execPromise(cmd);
              a.status = 'Active';
          } catch (e) {
              a.status = 'Failed';
          }
      });

      try {
          await Promise.all(pingPromises);
          saveDatabase(); // Save verified live status in local JSON database
      } catch (err) {
          console.error("Scanning search error: ", err);
      }

      res.json(matches);
  });

  app.get('/api/scan', async (req, res) => {
      const range = req.query.range as string;
      console.log(`Live Scan requested for range: ${range}`);

      res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
      });

      // Simple IP extraction e.g. "192.168.1.1-254" -> "192.168.1"
      // More robust extraction handling "192.168.1", "192.168.1.x", "192.168.1.1/24"
      let baseIp = "192.168.1";
      const match = range && range.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})/);
      if (!match) {
          res.write(`data: ${JSON.stringify({ complete: true, message: 'Invalid range format' })}\n\n`);
          return res.end();
      }
      baseIp = match[1];

      const isWin = process.platform === 'win32';
      const totalIPs = 254;
      let completed = 0;
      const chunkSize = isWin ? 50 : 20;

      // Mark all existing assets in this subnet as "Offline" initially before we ping
      assetsDatabase.forEach((a: any) => {
          if (a.ipAddress.startsWith(baseIp + '.')) {
              a.status = "Failed";
          }
      });

      const runPingChunk = async (start: number, end: number) => {
          const promises = [];
          for (let i = start; i <= end; i++) {
              const ip = `${baseIp}.${i}`;
              // Try to ping each IP within the chunk
              const cmd = isWin ? `ping -n 1 -w 500 ${ip}` : `ping -c 1 -W 1 ${ip}`;
              
              promises.push(new Promise<void>((resolve) => {
                  exec(cmd, (error) => {
                      completed++;
                      if (!error) {
                          // Successfully pinged the IP
                          let pcName = `PC-${ip.replace(/\./g, '-')}`;
                          
                          const addToDb = (name: string) => {
                              const existingIndex = assetsDatabase.findIndex((a: any) => a.ipAddress === ip);
                              
                              if (existingIndex !== -1) {
                                  assetsDatabase[existingIndex].status = "Active";
                                  assetsDatabase[existingIndex].asset = name;
                              } else {
                                  assetsDatabase.push({
                                      asset: name,
                                      ipAddress: ip,
                                      domain: "LOCAL.Network",
                                      status: "Active",
                                      processor: "N/A",
                                      ram: "N/A",
                                      vga: "N/A",
                                      model: "N/A",
                                      storage: "N/A",
                                      macAddress: "00:00:00:00:00:00",
                                      osVersion: "N/A",
                                      user: "N/A",
                                      uptimeEn: "0D 0H",
                                      uptimeAr: "0 يوم و 0 ساعة"
                                  });
                              }
                          };

                          addToDb(pcName);

                          // Quick async DNS reverse lookup without dragging down the loop
                          dns.reverse(ip, (err: any, hostnames: any) => {
                              if (!err && hostnames && hostnames.length > 0) {
                                  pcName = hostnames[0].split('.')[0].toUpperCase();
                                  addToDb(pcName);
                                  saveDatabase();
                              }
                          });

                          // Fetch REAL data asynchronously (ARP for MAC, WMIC for hardware if Windows)
                          if (isWin) {
                              // Get MAC Address via arp
                              exec(`arp -a ${ip}`, (err, stdout) => {
                                  if (!err && stdout) {
                                      const macMatch = stdout.match(/([0-9a-fA-F]{2}[:-]){5}([0-9a-fA-F]{2})/i);
                                      if (macMatch) {
                                          const idx = assetsDatabase.findIndex((a: any) => a.ipAddress === ip);
                                          if (idx !== -1) assetsDatabase[idx].macAddress = macMatch[0].toUpperCase().replace(/-/g, ':');
                                      }
                                  }
                              });

                              // Get wmic details (wrap in powershell to do it all in one call and avoid spawning too many processes)
                              // Note: Remote WMI might require domain admin privileges and firewall rules allowing it on the client.
                              const psCmd = `
                                $ErrorActionPreference = 'SilentlyContinue';
                                $cpu = (Get-WmiObject -ComputerName ${ip} Win32_Processor | Select-Object -First 1).Name;
                                $os = (Get-WmiObject -ComputerName ${ip} Win32_OperatingSystem | Select-Object -First 1).Caption;
                                $cs = Get-WmiObject -ComputerName ${ip} Win32_ComputerSystem | Select-Object -First 1;
                                $mem = Get-WmiObject -ComputerName ${ip} Win32_PhysicalMemory | Measure-Object -Property Capacity -Sum;
                                
                                $ramGb = [math]::Round($mem.Sum / 1GB);
                                
                                Write-Output "CPU:$cpu|OS:$os|Model:$($cs.Model)|User:$($cs.UserName)|RAM:$ramGb"
                              `.replace(/\n/g, ' ').trim();

                              exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCmd}"`, { timeout: 10000 }, (err, stdout) => {
                                  if (!err && stdout) {
                                      const idx = assetsDatabase.findIndex((a: any) => a.ipAddress === ip);
                                      if (idx !== -1) {
                                          const asset = assetsDatabase[idx];
                                          const cpuMatch = stdout.match(/CPU:(.*?)\|/i);
                                          const osMatch = stdout.match(/OS:(.*?)\|/i);
                                          const modelMatch = stdout.match(/Model:(.*?)\|/i);
                                          const userMatch = stdout.match(/User:(.*?)\|/i);
                                          const ramMatch = stdout.match(/RAM:(.*?)$/i);
                                          
                                          if (cpuMatch && cpuMatch[1].trim()) asset.processor = cpuMatch[1].trim();
                                          if (osMatch && osMatch[1].trim()) asset.osVersion = osMatch[1].trim();
                                          if (modelMatch && modelMatch[1].trim()) asset.model = modelMatch[1].trim();
                                          if (userMatch && userMatch[1].trim()) asset.user = userMatch[1].trim();
                                          if (ramMatch && ramMatch[1].trim() && parseInt(ramMatch[1].trim()) > 0) asset.ram = `${ramMatch[1].trim()} GB`;
                                          
                                          saveDatabase();
                                      }
                                  }
                              });
                          }
                      }
                      resolve();
                  });
              }));
          }
          await Promise.all(promises);
      };

      for (let i = 1; i <= totalIPs; i += chunkSize) {
          const end = Math.min(i + chunkSize - 1, totalIPs);
          await runPingChunk(i, end);
          
          // Stream progress back to the front-end
          const percent = Math.floor((completed / totalIPs) * 100);
          res.write(`data: ${JSON.stringify({ progress: percent })}\n\n`);
      }

      saveDatabase();
      res.write(`data: ${JSON.stringify({ progress: 100, complete: true })}\n\n`);
      res.end();
  });

  app.post('/api/assets', async (req, res) => {
      let incomingData = req.body;
      const existingIndex = assetsDatabase.findIndex((a: any) => a.ipAddress === incomingData.ipAddress);
      
      // Run AI to analyze the asset payload
      incomingData.aiReport = await getAIAnalysis(incomingData);

      if (existingIndex !== -1) {
          const oldData = assetsDatabase[existingIndex];
          let changes = [];

          if (oldData.ram !== incomingData.ram) changes.push(`RAM: ${oldData.ram} -> ${incomingData.ram}`);
          if (oldData.processor !== incomingData.processor) changes.push(`CPU changed`);
          
          const oldStorageStr = typeof oldData.storage === 'string' ? oldData.storage : JSON.stringify(oldData.storage);
          const incomingStorageStr = typeof incomingData.storage === 'string' ? incomingData.storage : JSON.stringify(incomingData.storage);
          if (oldStorageStr !== incomingStorageStr) changes.push(`Storage modified`);

          if (changes.length > 0) {
              incomingData.hardwareAlert = `⚠️ Hardware modified: ${changes.join(' | ')}`;
          } else {
              incomingData.hardwareAlert = oldData.hardwareAlert || null;
          }

          assetsDatabase[existingIndex] = incomingData;
      } else {
          incomingData.hardwareAlert = null;
          assetsDatabase.push(incomingData);
      }
      
      saveDatabase();
      console.log(`[-] AI Analysis completed and saved for IP: ${incomingData.ipAddress}`);
      res.status(200).json({ message: "Success", aiReport: incomingData.aiReport });
  });

  app.get('/api/data', async (req, res) => {
      try {
          const localData = await getLocalSystemData();
          
          // Merge local data with existing database to keep AI reports
          const existingIndex = assetsDatabase.findIndex((a: any) => a.asset === localData.asset || a.ipAddress === localData.ipAddress);
          if (existingIndex !== -1) {
              const existingData = assetsDatabase[existingIndex];
              localData.hardwareAlert = existingData.hardwareAlert;
              (localData as any).aiReport = existingData.aiReport || null;
              assetsDatabase[existingIndex] = localData;
          } else {
              assetsDatabase.push(localData);
          }
          saveDatabase();
          
          res.json(assetsDatabase); // Send all accumulated assets
      } catch (e) {
          console.error("Error getting local data:", e);
          res.json(assetsDatabase);
      }
  });

  app.get('/api/action/ping/:ip', (req, res) => {
      const { ip } = req.params;
      console.log(`[Action] Initiated real Ping execution for ${ip}`);
      
      const isWin = process.platform === 'win32';
      
      if (isWin) {
          // Open a new CMD window running the continuous ping command
          exec(`start cmd.exe /k "ping ${ip} -t"`, (error: any, stdout: string, stderr: string) => {
              res.status(200).json({
                  success: true,
                  isRealCommand: true,
                  output: `Opening CMD for continuous ping to ${ip}...`
              });
          });
      } else {
          // For non-Windows environments just run the normal ping and return the output
          const command = `ping -c 4 ${ip}`;
          exec(command, (error: any, stdout: string, stderr: string) => {
              const outputText = stdout || stderr || (error ? error.message : '');
              res.status(200).json({
                  success: !error,
                  isRealCommand: true,
                  output: outputText
              });
          });
      }
  });

  app.get('/api/action/openc/:ip', (req, res) => {
      const { ip } = req.params;
      console.log(`[Action] Attempting local Explorer launch for active SMB path: \\\\${ip}\\C$`);
      
      if (process.platform === 'win32') {
          // If the server is running on the administrator's local Windows PC,
          // running this command will open a real Windows Explorer window on their side!
          // We use explorer.exe explicitly because start cmd will fallback to Documents if path doesn't exist
          const cmd = `explorer.exe "\\\\${ip}\\C$"`;
          exec(cmd, (error: any, stdout: string, stderr: string) => {
              if (error) {
                  console.error(`[-] Windows Explorer launch failed: ${error.message}`);
                  return res.status(200).json({
                      success: false,
                      isRealCommand: true,
                      message: `فشل الوصول للمسار المشترك: ${error.message}. (قد يكون الجهاز مغلق أو لا تملك صلاحية)`
                  });
              }
              res.status(200).json({
                  success: true,
                  isRealCommand: true,
                  message: `تم إطلاق نافذة مستكشف ملفات Windows بنجاح للمسار المشترك \\\\${ip}\\C$`
              });
          });
      } else {
          // In non-Windows cloud preview/docker environment, provide standard success response with simulation indicators
          console.log(`[Simulation] Non-Windows OS detected (${process.platform}). Simulating remote folder mapping.`);
          res.status(200).json({
              success: true,
              isRealCommand: false,
              message: `تم محاكاة فتح المسار المشترك لجهازك العميل (بيئة غير ويندوز)`
          });
      }
  });

  app.post('/api/action/acknowledge/:ip', (req, res) => {
      const { ip } = req.params;
      const existingIndex = assetsDatabase.findIndex((a: any) => a.ipAddress === ip);
      if (existingIndex !== -1) {
          assetsDatabase[existingIndex].hardwareAlert = null;
          saveDatabase();
          res.json({ success: true, message: 'Alert acknowledged' });
      } else {
          res.status(404).json({ success: false, message: 'Asset not found' });
      }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa", // This serves index.html natively 
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
      const serverUrl = `http://localhost:${PORT}`;
      console.log(`Server is running on: ${serverUrl}`);
      
      // Auto-open browser when running on local Windows machine in standalone or built mode
      const isDevelopment = process.env.NODE_ENV !== "production";
      const isCloudContainer = !!process.env.K_SERVICE || !!process.env.CLOUD_RUN_JOB_ID || !!process.env.PORT;
      
      if (!isCloudContainer) {
          const cmd = process.platform === 'win32' 
              ? `start ${serverUrl}` 
              : process.platform === 'darwin' 
                  ? `open ${serverUrl}` 
                  : `xdg-open ${serverUrl}`;
                  
          setTimeout(() => {
              console.log(`[Standalone] Automatically opening browser path: ${serverUrl}`);
              exec(cmd, (err: any) => {
                  if (err) console.error("[-] Failed to auto-launch default system web browser: ", err.message);
              });
          }, 1200); // Small grace delay to ensure web server is fully booted and accepting sockets
      }
  });
}

startServer();
