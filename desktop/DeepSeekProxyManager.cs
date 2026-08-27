using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using Drawing = System.Drawing;
using Ellipse = System.Windows.Shapes.Ellipse;

[assembly: AssemblyTitle("DeepSeek Claude Proxy Manager")]
[assembly: AssemblyDescription("Native Windows manager for the local Claude-to-DeepSeek proxy")]
[assembly: AssemblyCompany("Local")]
[assembly: AssemblyProduct("DeepSeek Claude Proxy Manager")]
[assembly: AssemblyVersion("1.6.14.0")]
[assembly: AssemblyFileVersion("1.6.14.0")]

namespace ClaudeDeepSeekProxyManager
{
    internal static class Program
    {
        private const string MutexName = "Local\\ClaudeDeepSeekProxyManager.Singleton";
        private static Mutex _mutex;

        [STAThread]
        private static void Main(string[] args)
        {
            bool createdNew;
            _mutex = new Mutex(true, MutexName, out createdNew);
            if (!createdNew)
            {
                MessageBox.Show("DeepSeek 代理管理器已经在运行。请检查系统托盘。", "DeepSeek 代理管理器",
                    MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            // This manager is a static control panel. Software rendering avoids
            // the large shared-GPU reservation observed with some Intel drivers
            // while keeping interaction costs negligible.
            RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
            var app = new Application();
            app.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            var window = new ManagerWindow(args);
            app.Run(window);
            _mutex.ReleaseMutex();
            _mutex.Dispose();
        }
    }

    internal sealed class ManagerWindow : Window
    {
        private const string AppRegistryPath = "Software\\ClaudeDeepSeekProxyManager";
        private const string RunRegistryPath = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
        private const string RunValueName = "ClaudeDeepSeekProxyManager";
        private static readonly SolidColorBrush StoppedBrush = CreateFrozenBrush(151, 162, 178);
        private static readonly SolidColorBrush StartingBrush = CreateFrozenBrush(238, 164, 55);
        private static readonly SolidColorBrush SuccessBrush = CreateFrozenBrush(31, 170, 104);
        private static readonly SolidColorBrush ErrorBrush = CreateFrozenBrush(225, 75, 75);

        private readonly string _appDirectory;
        private readonly string _proxyScriptPath;
        private readonly string _logPath;
        private readonly bool _autoStartInvocation;
        private readonly FrameworkElement _viewRoot;

        private PasswordBox _apiKeyBox;
        private TextBox _portBox;
        private TextBox _sonnetAliasBox;
        private TextBox _sonnetTargetBox;
        private TextBox _opusAliasBox;
        private TextBox _opusTargetBox;
        private TextBox _haikuAliasBox;
        private TextBox _haikuTargetBox;
        private TextBox _logBox;
        private Image _headerIcon;
        private TextBlock _statusText;
        private TextBlock _statusDetail;
        private TextBlock _proxyStateTitle;
        private TextBlock _nodeText;
        private TextBlock _endpointText;
        private TextBlock _gatewayKeySummaryText;
        private Ellipse _statusDot;
        private Ellipse _centerStatusDot;
        private Button _startButton;
        private Button _stopButton;
        private Button _restartButton;
        private Button _testButton;
        private Button _openLogButton;
        private Button _copyEndpointButton;
        private Button _copyGatewayKeyButton;
        private Button _manageGatewayKeyButton;
        private CheckBox _minimizeToTrayCheck;
        private CheckBox _autoStartCheck;

        private Process _proxyProcess;
        private Window _logWindow;
        private Forms.NotifyIcon _trayIcon;
        private Forms.ContextMenuStrip _trayMenu;
        private Drawing.Icon _applicationIcon;
        private Forms.ToolStripMenuItem _trayStartItem;
        private Forms.ToolStripMenuItem _trayStopItem;
        private DispatcherTimer _healthTimer;
        private DispatcherTimer _logTimer;
        private bool _refreshingHealth;
        private bool _exiting;
        private bool _externalProxyDetected;
        private StatusKind? _lastStatusKind;
        private string _lastStatusTitle = "";
        private string _lastStatusDetail = "";
        private bool? _lastRunningState;
        private bool? _lastOwnedState;
        private int _statusGeneration;
        private string _lastLogText = "";
        private string _nodePath = "";
        private string _nodeVersion = "";
        private string _gatewayApiKey = "";

        public ManagerWindow(string[] args)
        {
            _autoStartInvocation = Array.Exists(args, delegate(string value)
            {
                return string.Equals(value, "--autostart", StringComparison.OrdinalIgnoreCase);
            });

            _appDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            _proxyScriptPath = FindProxyScript(_appDirectory);
            _logPath = Path.Combine(Path.GetDirectoryName(_proxyScriptPath) ?? _appDirectory, "proxy.log");

            Title = "DeepSeek Claude Proxy";
            var workArea = SystemParameters.WorkArea;
            MinWidth = Math.Min(1000, workArea.Width);
            MinHeight = Math.Min(680, workArea.Height);
            Width = Math.Min(1120, Math.Max(MinWidth, workArea.Width - 48));
            Height = Math.Min(728, Math.Max(MinHeight, workArea.Height));
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = new SolidColorBrush(Color.FromRgb(246, 248, 252));
            FontFamily = new FontFamily("Microsoft YaHei UI");
            FontSize = 13;

            _viewRoot = (FrameworkElement)XamlReader.Parse(WindowXaml);
            Content = _viewRoot;
            BindControls();
            ApplyApplicationIcon();
            WireEvents();
            LoadSettings();
            UpdateConfigurationPreview();
            ConfigureTrayIcon();
            ConfigureTimers();

            Loaded += OnLoaded;
            Closing += OnClosing;
            StateChanged += delegate { UpdatePollingCadence(); };
        }

        private void BindControls()
        {
            _apiKeyBox = _viewRoot.FindName("ApiKeyBox") as PasswordBox;
            _portBox = _viewRoot.FindName("PortBox") as TextBox;
            _sonnetAliasBox = _viewRoot.FindName("SonnetAliasBox") as TextBox;
            _sonnetTargetBox = _viewRoot.FindName("SonnetTargetBox") as TextBox;
            _opusAliasBox = _viewRoot.FindName("OpusAliasBox") as TextBox;
            _opusTargetBox = _viewRoot.FindName("OpusTargetBox") as TextBox;
            _haikuAliasBox = _viewRoot.FindName("HaikuAliasBox") as TextBox;
            _haikuTargetBox = _viewRoot.FindName("HaikuTargetBox") as TextBox;
            _headerIcon = _viewRoot.FindName("HeaderIcon") as Image;
            _statusText = _viewRoot.FindName("StatusText") as TextBlock;
            _statusDetail = _viewRoot.FindName("StatusDetail") as TextBlock;
            _proxyStateTitle = _viewRoot.FindName("ProxyStateTitle") as TextBlock;
            _nodeText = _viewRoot.FindName("NodeText") as TextBlock;
            _endpointText = _viewRoot.FindName("EndpointText") as TextBlock;
            _gatewayKeySummaryText = _viewRoot.FindName("GatewayKeySummaryText") as TextBlock;
            _statusDot = _viewRoot.FindName("StatusDot") as Ellipse;
            _centerStatusDot = _viewRoot.FindName("CenterStatusDot") as Ellipse;
            _startButton = _viewRoot.FindName("StartButton") as Button;
            _stopButton = _viewRoot.FindName("StopButton") as Button;
            _restartButton = _viewRoot.FindName("RestartButton") as Button;
            _testButton = _viewRoot.FindName("TestButton") as Button;
            _openLogButton = _viewRoot.FindName("OpenLogButton") as Button;
            _copyEndpointButton = _viewRoot.FindName("CopyEndpointButton") as Button;
            _copyGatewayKeyButton = _viewRoot.FindName("CopyGatewayKeyButton") as Button;
            _manageGatewayKeyButton = _viewRoot.FindName("ManageGatewayKeyButton") as Button;
            _minimizeToTrayCheck = _viewRoot.FindName("MinimizeToTrayCheck") as CheckBox;
            _autoStartCheck = _viewRoot.FindName("AutoStartCheck") as CheckBox;
        }

        private void WireEvents()
        {
            ((Button)_viewRoot.FindName("SaveKeyButton")).Click += delegate
            {
                if (SaveSettings(true))
                    ShowTransientStatus("设置已安全保存", "API Key 已加密，模型映射也已保存。", StatusKind.Success);
            };
            _startButton.Click += async delegate { await StartProxyAsync(); };
            _stopButton.Click += delegate { StopOwnedProxy(); };
            _restartButton.Click += async delegate { await RestartProxyAsync(); };
            _testButton.Click += async delegate { await TestConnectionAsync(true); };
            _openLogButton.Click += delegate { ShowLogWindow(); };
            _copyEndpointButton.Click += delegate { CopyEndpoint(); };
            _copyGatewayKeyButton.Click += delegate { CopyGatewayKey(); };
            _manageGatewayKeyButton.Click += async delegate { await ShowGatewayKeyManagerAsync(); };
            ((Button)_viewRoot.FindName("OpenFolderButton")).Click += delegate { OpenAppFolder(); };
            _portBox.TextChanged += delegate { UpdateConfigurationPreview(); };
            _autoStartCheck.Click += delegate
            {
                if (SaveSettings(false)) ApplyWindowsAutoStart(_autoStartCheck.IsChecked == true);
            };
            _minimizeToTrayCheck.Click += delegate { SaveSettings(false); };
        }

        private void ApplyApplicationIcon()
        {
            var iconPath = Path.Combine(_appDirectory, "DeepSeekProxyManager.ico");
            if (!File.Exists(iconPath)) return;

            try
            {
                var windowBitmap = BitmapFrame.Create(new Uri(iconPath, UriKind.Absolute));
                Icon = windowBitmap;
                if (_headerIcon != null)
                {
                    using (var stream = File.OpenRead(iconPath))
                    {
                        var decoder = BitmapDecoder.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
                        BitmapFrame headerBitmap = null;
                        var closestDistance = int.MaxValue;
                        foreach (var frame in decoder.Frames)
                        {
                            var distance = Math.Abs(frame.PixelWidth - 48);
                            if (distance >= closestDistance) continue;
                            closestDistance = distance;
                            headerBitmap = frame;
                        }
                        _headerIcon.Source = headerBitmap ?? windowBitmap;
                    }
                }
            }
            catch
            {
                // The embedded EXE icon is still available if an external icon cannot be loaded.
            }
        }

        private void ConfigureTimers()
        {
            _healthTimer = new DispatcherTimer();
            _healthTimer.Interval = TimeSpan.FromSeconds(10);
            _healthTimer.Tick += async delegate { await RefreshHealthAsync(); };

            _logTimer = new DispatcherTimer();
            _logTimer.Interval = TimeSpan.FromSeconds(2);
            _logTimer.Tick += delegate { RefreshLog(); };
        }

        private void UpdatePollingCadence()
        {
            if (_healthTimer == null) return;
            var foreground = IsVisible && WindowState != WindowState.Minimized;
            _healthTimer.Interval = TimeSpan.FromSeconds(foreground ? 10 : 45);
        }

        private void ConfigureTrayIcon()
        {
            _trayIcon = new Forms.NotifyIcon();
            var iconPath = Path.Combine(_appDirectory, "DeepSeekProxyManager.ico");
            try
            {
                _applicationIcon = File.Exists(iconPath) ? new Drawing.Icon(iconPath) : null;
            }
            catch
            {
                _applicationIcon = null;
            }
            _trayIcon.Icon = _applicationIcon ?? Drawing.SystemIcons.Application;
            _trayIcon.Text = "DeepSeek 代理管理器";
            _trayIcon.Visible = true;
            _trayIcon.DoubleClick += delegate { Dispatcher.BeginInvoke(new Action(ShowFromTray)); };

            _trayMenu = TrayMenuTheme.CreateMenu();
            var showItem = TrayMenuTheme.CreateItem(
                "打开管理器", TrayMenuGlyph.Open, Drawing.Color.FromArgb(82, 121, 232), true);
            showItem.Click += delegate { Dispatcher.BeginInvoke(new Action(ShowFromTray)); };
            _trayStartItem = TrayMenuTheme.CreateItem(
                "启动代理", TrayMenuGlyph.Start, Drawing.Color.FromArgb(38, 166, 106), false);
            _trayStartItem.Click += delegate { Dispatcher.BeginInvoke(new Action(async delegate { await StartProxyAsync(); })); };
            _trayStopItem = TrayMenuTheme.CreateItem(
                "停止代理", TrayMenuGlyph.Stop, Drawing.Color.FromArgb(226, 153, 51), false);
            _trayStopItem.Click += delegate { Dispatcher.BeginInvoke(new Action(delegate { StopOwnedProxy(); })); };
            var exitItem = TrayMenuTheme.CreateItem(
                "退出", TrayMenuGlyph.Exit, Drawing.Color.FromArgb(224, 82, 94), false);
            exitItem.Click += delegate { Dispatcher.BeginInvoke(new Action(ExitApplication)); };

            _trayMenu.Items.Add(showItem);
            _trayMenu.Items.Add(TrayMenuTheme.CreateSeparator());
            _trayMenu.Items.Add(_trayStartItem);
            _trayMenu.Items.Add(_trayStopItem);
            _trayMenu.Items.Add(TrayMenuTheme.CreateSeparator());
            _trayMenu.Items.Add(exitItem);
            _trayIcon.ContextMenuStrip = _trayMenu;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            UpdatePollingCadence();
            _healthTimer.Start();
            await RefreshHealthAsync();

            if (_autoStartInvocation)
            {
                Hide();
                UpdatePollingCadence();
                if (!await IsProxyHealthyAsync())
                {
                    await StartProxyAsync();
                }
            }
        }

        private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
        {
            if (!_exiting && _minimizeToTrayCheck.IsChecked == true)
            {
                e.Cancel = true;
                Hide();
                if (_logWindow != null) _logWindow.Hide();
                _logTimer.Stop();
                UpdatePollingCadence();
                _trayIcon.ShowBalloonTip(1500, "DeepSeek 代理管理器", "程序仍在系统托盘中运行。", Forms.ToolTipIcon.Info);
                return;
            }

            _healthTimer.Stop();
            _logTimer.Stop();
            if (_logWindow != null) _logWindow.Close();
            StopOwnedProxy("manager_exit");
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            if (_trayMenu != null) _trayMenu.Dispose();
            if (_applicationIcon != null) _applicationIcon.Dispose();
            Application.Current.Shutdown();
        }

        private async Task StartProxyAsync()
        {
            ReleaseExitedProxyProcess();
            if (_proxyProcess != null && !_proxyProcess.HasExited)
            {
                ShowTransientStatus("代理已经运行", "当前进程由本管理器启动。", StatusKind.Success);
                return;
            }

            if (await IsProxyHealthyAsync())
            {
                _externalProxyDetected = true;
                SetStatus(StatusKind.Success, "代理正在运行", "检测到端口上的现有代理；为安全起见不会接管该进程。");
                UpdateButtonState(true, false);
                return;
            }

            int port;
            if (!TryGetPort(out port)) return;

            string opusAlias;
            string opusTarget;
            string sonnetAlias;
            string sonnetTarget;
            string haikuAlias;
            string haikuTarget;
            if (!TryGetModelMapping(out opusAlias, out opusTarget, out sonnetAlias, out sonnetTarget, out haikuAlias, out haikuTarget)) return;

            var apiKey = _apiKeyBox.Password;
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                MessageBox.Show("请先输入 DeepSeek API Key。", "缺少 API Key", MessageBoxButton.OK, MessageBoxImage.Warning);
                _apiKeyBox.Focus();
                return;
            }

            if (!File.Exists(_proxyScriptPath))
            {
                MessageBox.Show("找不到代理核心：\n" + _proxyScriptPath, "无法启动", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            _nodePath = FindNodeExecutable();
            if (string.IsNullOrEmpty(_nodePath))
            {
                MessageBox.Show("未找到 Node.js 20 或更高版本。请安装 Node.js，或将 node.exe 放在程序目录。",
                    "缺少 Node.js", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            var nodeVersion = GetNodeVersion(_nodePath);
            int nodeMajor;
            if (!TryParseNodeMajor(nodeVersion, out nodeMajor) || nodeMajor < 20)
            {
                MessageBox.Show("需要 Node.js 20 或更高版本，当前检测到：" + nodeVersion,
                    "Node.js 版本过低", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
            _nodeVersion = nodeVersion;

            if (!SaveSettings(true)) return;
            SetStatus(StatusKind.Starting, "正在启动", "正在启动本地代理，请稍候…");
            UpdateButtonState(false, true);

            try
            {
                var startInfo = new ProcessStartInfo();
                startInfo.FileName = _nodePath;
                startInfo.Arguments = QuoteArgument(_proxyScriptPath);
                startInfo.WorkingDirectory = Path.GetDirectoryName(_proxyScriptPath) ?? _appDirectory;
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.RedirectStandardInput = true;
                startInfo.EnvironmentVariables["DEEPSEEK_API_KEY"] = apiKey;
                startInfo.EnvironmentVariables["DEEPSEEK_BASE_URL"] = "https://api.deepseek.com/anthropic";
                startInfo.EnvironmentVariables["MODEL_MAP_JSON"] = BuildModelMapJson(opusAlias, opusTarget, sonnetAlias, sonnetTarget, haikuAlias, haikuTarget);
                startInfo.EnvironmentVariables["PORT"] = port.ToString();
                startInfo.EnvironmentVariables["HOST"] = "127.0.0.1";
                startInfo.EnvironmentVariables["LOG_FILE"] = _logPath;
                startInfo.EnvironmentVariables["LOG_MAX_BYTES"] = "1048576";
                startInfo.EnvironmentVariables["LOG_BACKUPS"] = "3";
                startInfo.EnvironmentVariables["MAX_BODY_BYTES"] = "26214400";
                startInfo.EnvironmentVariables["UPSTREAM_TIMEOUT_MS"] = "120000";
                startInfo.EnvironmentVariables["CORS_ORIGIN"] = "";
                startInfo.EnvironmentVariables["PROXY_API_KEY"] = _gatewayApiKey;

                _proxyProcess = new Process();
                _proxyProcess.StartInfo = startInfo;
                _proxyProcess.EnableRaisingEvents = true;
                _proxyProcess.OutputDataReceived += OnProxyOutput;
                _proxyProcess.ErrorDataReceived += OnProxyOutput;
                _proxyProcess.Exited += OnProxyExited;
                _proxyProcess.Start();
                _proxyProcess.BeginOutputReadLine();
                _proxyProcess.BeginErrorReadLine();

                var deadline = DateTime.UtcNow.AddSeconds(8);
                while (DateTime.UtcNow < deadline)
                {
                    if (_proxyProcess.HasExited) break;
                    if (await IsProxyHealthyAsync())
                    {
                        _externalProxyDetected = false;
                        SetStatus(StatusKind.Success, "代理已运行", "http://127.0.0.1:" + port + " · Node " + nodeVersion);
                        UpdateButtonState(true, true);
                        _trayIcon.ShowBalloonTip(1200, "DeepSeek 代理", "代理已在端口 " + port + " 启动。", Forms.ToolTipIcon.Info);
                        return;
                    }
                    await Task.Delay(250);
                }

                if (_proxyProcess.HasExited)
                {
                    SetStatus(StatusKind.Error, "启动失败", "代理进程已退出，请查看运行日志。");
                    ReleaseExitedProxyProcess();
                    UpdateButtonState(false, false);
                }
                else
                {
                    SetStatus(StatusKind.Error, "启动超时", "进程仍在运行，但健康检查没有通过。");
                    UpdateButtonState(true, true);
                }
            }
            catch (Exception exception)
            {
                SetStatus(StatusKind.Error, "启动失败", exception.Message);
                var ownedRunning = false;
                try { ownedRunning = _proxyProcess != null && !_proxyProcess.HasExited; }
                catch { ownedRunning = false; }
                if (!ownedRunning && _proxyProcess != null)
                {
                    var failedProcess = _proxyProcess;
                    _proxyProcess = null;
                    failedProcess.Dispose();
                }
                UpdateButtonState(ownedRunning, ownedRunning);
                MessageBox.Show(exception.Message, "无法启动代理", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private void StopOwnedProxy(string reason = "manual_stop")
        {
            ReleaseExitedProxyProcess();
            if (_proxyProcess == null || _proxyProcess.HasExited)
            {
                if (_externalProxyDetected)
                {
                    SetStatus(StatusKind.Success, "代理正在运行", "该进程不是由本管理器启动，因此不会强制结束。请关闭原 PowerShell 窗口。");
                }
                else
                {
                    SetStatus(StatusKind.Stopped, "代理已停止", "可以安全修改端口或 API Key。");
                }
                UpdateButtonState(_externalProxyDetected, false);
                return;
            }

            var process = _proxyProcess;
            var stopped = false;
            try
            {
                SetStatus(StatusKind.Starting, "正在停止", "正在结束本管理器启动的代理进程…");
                var gracefulRequested = TryRequestGracefulShutdown(process, reason);
                if (gracefulRequested)
                    stopped = process.WaitForExit(2800) || process.HasExited;
                if (!stopped)
                {
                    process.Kill();
                    stopped = process.WaitForExit(1000) || process.HasExited;
                }
                if (!stopped) throw new TimeoutException("代理进程未能在 3 秒内退出。");
            }
            catch (Exception exception)
            {
                SetStatus(StatusKind.Error, "停止失败", exception.Message);
                return;
            }
            finally
            {
                if (stopped)
                {
                    process.Dispose();
                    if (ReferenceEquals(_proxyProcess, process)) _proxyProcess = null;
                }
            }

            _externalProxyDetected = false;
            SetStatus(StatusKind.Stopped, "代理已停止", "本地端口已释放。");
            UpdateButtonState(false, false);
        }

        private async Task RestartProxyAsync()
        {
            if (_externalProxyDetected && (_proxyProcess == null || _proxyProcess.HasExited))
            {
                MessageBox.Show("当前代理不是由本管理器启动，无法安全重启。请先关闭原 PowerShell 代理。",
                    "无法接管现有进程", MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            StopOwnedProxy("restart");
            await Task.Delay(500);
            await StartProxyAsync();
        }

        private async Task TestConnectionAsync(bool showDialog)
        {
            _testButton.IsEnabled = false;
            try
            {
                var healthy = await IsProxyHealthyAsync();
                var modelsAvailable = healthy && await IsProxyModelsAvailableAsync();
                if (modelsAvailable)
                {
                    SetStatus(StatusKind.Success, "连接正常", "本地健康检查和模型列表均可访问。");
                    if (showDialog)
                        MessageBox.Show("本地代理连接正常，模型列表读取成功。", "测试成功", MessageBoxButton.OK, MessageBoxImage.Information);
                }
                else
                {
                    var detail = healthy
                        ? "健康检查正常，但模型列表读取失败。"
                        : "无法访问本地代理，请确认代理已经启动。";
                    SetStatus(StatusKind.Error, "连接失败", detail);
                    if (showDialog)
                        MessageBox.Show(detail, "测试失败", MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            }
            finally
            {
                _testButton.IsEnabled = true;
            }
        }

        private async Task RefreshHealthAsync()
        {
            if (_refreshingHealth) return;
            _refreshingHealth = true;
            try
            {
                if (_proxyProcess != null && _proxyProcess.HasExited)
                {
                    ReleaseExitedProxyProcess();
                    _externalProxyDetected = false;
                    SetStatus(StatusKind.Error, "代理意外退出", "请查看日志了解详细原因，然后重新启动。");
                    UpdateButtonState(false, false);
                    return;
                }
                var healthy = await IsProxyHealthyAsync();
                var owned = _proxyProcess != null && !_proxyProcess.HasExited;
                if (healthy)
                {
                    _externalProxyDetected = !owned;
                    int port;
                    TryGetPortSilently(out port);
                    SetStatus(StatusKind.Success, "代理已运行", "http://127.0.0.1:" + port + (owned ? " · 由本管理器启动" : " · 外部进程"));
                    UpdateButtonState(true, owned);
                }
                else if (!owned)
                {
                    _externalProxyDetected = false;
                    SetStatus(StatusKind.Stopped, "代理未运行", "输入 API Key 后即可一键启动。" );
                    UpdateButtonState(false, false);
                }
            }
            finally
            {
                _refreshingHealth = false;
            }
        }

        private async Task<bool> IsProxyHealthyAsync()
        {
            int port;
            if (!TryGetPortSilently(out port)) return false;
            var gatewayKey = _gatewayApiKey;
            if (string.IsNullOrWhiteSpace(gatewayKey)) return false;

            return await Task.Run(delegate
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/health");
                    request.Method = "GET";
                    request.Timeout = 1500;
                    request.ReadWriteTimeout = 1500;
                    request.Proxy = null;
                    request.KeepAlive = false;
                    request.Headers[HttpRequestHeader.Authorization] = "Bearer " + gatewayKey;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    using (var reader = new StreamReader(response.GetResponseStream()))
                    {
                        var body = reader.ReadToEnd();
                        return response.StatusCode == HttpStatusCode.OK && body.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                    }
                }
                catch
                {
                    return false;
                }
            });
        }

        private async Task<bool> IsProxyModelsAvailableAsync()
        {
            int port;
            if (!TryGetPortSilently(out port)) return false;
            var gatewayKey = _gatewayApiKey;
            if (string.IsNullOrWhiteSpace(gatewayKey)) return false;

            return await Task.Run(delegate
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/v1/models");
                    request.Method = "GET";
                    request.Timeout = 1500;
                    request.ReadWriteTimeout = 1500;
                    request.Proxy = null;
                    request.KeepAlive = false;
                    request.Headers[HttpRequestHeader.Authorization] = "Bearer " + gatewayKey;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    using (var reader = new StreamReader(response.GetResponseStream()))
                    {
                        var body = reader.ReadToEnd();
                        return response.StatusCode == HttpStatusCode.OK &&
                            Regex.IsMatch(body, "\\\"data\\\"\\s*:\\s*\\[\\s*\\{");
                    }
                }
                catch
                {
                    return false;
                }
            });
        }

        private void OnProxyOutput(object sender, DataReceivedEventArgs e)
        {
            // Keep both redirected streams drained. Runtime details belong in the
            // dedicated log window; updating the main status for every line caused
            // unnecessary WPF layout and rendering work during long sessions.
        }

        private void OnProxyExited(object sender, EventArgs e)
        {
            var exitedProcess = sender as Process;
            Dispatcher.BeginInvoke(new Action(delegate
            {
                if (_exiting || _proxyProcess == null || !ReferenceEquals(exitedProcess, _proxyProcess)) return;
                _proxyProcess = null;
                exitedProcess.Dispose();
                _externalProxyDetected = false;
                SetStatus(StatusKind.Error, "代理意外退出", "请查看日志了解详细原因，然后重新启动。" );
                UpdateButtonState(false, false);
            }));
        }

        private void ShowLogWindow()
        {
            if (_logWindow != null)
            {
                _logWindow.Show();
                _logWindow.WindowState = WindowState.Normal;
                _logWindow.Activate();
                RefreshLog();
                _logTimer.Start();
                return;
            }

            var root = (FrameworkElement)XamlReader.Parse(LogWindowXaml);
            var window = new Window();
            window.Title = "DeepSeek 代理运行日志";
            window.Width = 860;
            window.Height = 560;
            window.MinWidth = 640;
            window.MinHeight = 400;
            window.WindowStartupLocation = WindowStartupLocation.CenterOwner;
            window.Owner = this;
            window.Background = new SolidColorBrush(Color.FromRgb(17, 24, 39));
            window.FontFamily = new FontFamily("Microsoft YaHei UI");
            window.Icon = Icon;
            window.Content = root;

            _logBox = root.FindName("LogBox") as TextBox;
            ((Button)root.FindName("ClearLogButton")).Click += delegate { ClearLog(); };
            ((Button)root.FindName("OpenLogFolderButton")).Click += delegate { OpenAppFolder(); };
            window.Closed += delegate
            {
                _logTimer.Stop();
                _logWindow = null;
                _logBox = null;
                _lastLogText = "";
            };

            _logWindow = window;
            _lastLogText = "";
            RefreshLog();
            _logTimer.Start();
            window.Show();
        }

        private void RefreshLog()
        {
            if (_logBox == null) return;
            try
            {
                if (!File.Exists(_logPath))
                {
                    if (_lastLogText.Length == 0) _logBox.Text = "暂无日志。启动代理后，这里会显示最近的运行记录。";
                    return;
                }

                string content;
                using (var stream = new FileStream(_logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (stream.Length > 65536) stream.Seek(-65536, SeekOrigin.End);
                    using (var reader = new StreamReader(stream, Encoding.UTF8, true))
                    {
                        content = reader.ReadToEnd();
                    }
                }

                var lines = content.Replace("\r\n", "\n").Split('\n');
                var start = Math.Max(0, lines.Length - 160);
                var builder = new StringBuilder();
                for (var index = start; index < lines.Length; index++)
                {
                    if (lines[index].Length == 0) continue;
                    builder.AppendLine(FormatLogLine(lines[index]));
                }
                var display = builder.ToString();
                if (display == _lastLogText) return;
                _lastLogText = display;
                _logBox.Text = display;
                _logBox.ScrollToEnd();
            }
            catch (IOException)
            {
                // The proxy may be rotating the log; the next timer tick will retry.
            }
        }

        private static string FormatLogLine(string line)
        {
            DateTime timestamp;
            if (line.Length > 24 && DateTime.TryParse(line.Substring(0, 24), out timestamp))
            {
                return timestamp.ToLocalTime().ToString("HH:mm:ss") + line.Substring(24);
            }
            return line;
        }

        private void ClearLog()
        {
            try
            {
                File.WriteAllText(_logPath, "", new UTF8Encoding(false));
                _lastLogText = "";
                if (_logBox != null) _logBox.Text = "日志已清空。";
            }
            catch (Exception exception)
            {
                MessageBox.Show("无法清空日志：" + exception.Message, "操作失败", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private void LoadSettings()
        {
            using (var key = Registry.CurrentUser.CreateSubKey(AppRegistryPath))
            {
                _portBox.Text = Convert.ToString(key.GetValue("Port", "3210"));
                _sonnetAliasBox.Text = Convert.ToString(key.GetValue("SonnetAliasModel", "claude-sonnet-4-5"));
                _sonnetTargetBox.Text = Convert.ToString(key.GetValue("SonnetTargetModel", "deepseek-v4-flash"));
                _opusAliasBox.Text = Convert.ToString(key.GetValue("OpusAliasModel", "claude-opus-4-5"));
                _opusTargetBox.Text = Convert.ToString(key.GetValue("OpusTargetModel", "deepseek-v4-pro"));
                _haikuAliasBox.Text = Convert.ToString(key.GetValue("HaikuAliasModel", "claude-haiku-4-5"));
                _haikuTargetBox.Text = Convert.ToString(key.GetValue("HaikuTargetModel", "deepseek-v4-flash"));
                _minimizeToTrayCheck.IsChecked = Convert.ToInt32(key.GetValue("MinimizeToTray", 1)) != 0;
                _autoStartCheck.IsChecked = Convert.ToInt32(key.GetValue("AutoStart", 0)) != 0;
                var protectedValue = Convert.ToString(key.GetValue("ApiKey", ""));
                if (!string.IsNullOrEmpty(protectedValue))
                {
                    try { _apiKeyBox.Password = UnprotectSecret(protectedValue); }
                    catch { _apiKeyBox.Password = ""; }
                }

                var protectedGatewayKey = Convert.ToString(key.GetValue("ProxyApiKey", ""));
                if (!string.IsNullOrEmpty(protectedGatewayKey))
                {
                    try { _gatewayApiKey = UnprotectSecret(protectedGatewayKey); }
                    catch { _gatewayApiKey = ""; }
                }
                if (string.IsNullOrWhiteSpace(_gatewayApiKey))
                {
                    _gatewayApiKey = CreateGatewayApiKey();
                    key.SetValue("ProxyApiKey", ProtectSecret(_gatewayApiKey), RegistryValueKind.String);
                }
            }
            UpdateGatewayKeySummary();
        }

        private bool SaveSettings(bool includeApiKey)
        {
            int port;
            if (!TryGetPort(out port)) return false;

            string opusAlias;
            string opusTarget;
            string sonnetAlias;
            string sonnetTarget;
            string haikuAlias;
            string haikuTarget;
            if (!TryGetModelMapping(out opusAlias, out opusTarget, out sonnetAlias, out sonnetTarget, out haikuAlias, out haikuTarget)) return false;

            using (var key = Registry.CurrentUser.CreateSubKey(AppRegistryPath))
            {
                key.SetValue("Port", port, RegistryValueKind.DWord);
                key.SetValue("SonnetAliasModel", sonnetAlias, RegistryValueKind.String);
                key.SetValue("SonnetTargetModel", sonnetTarget, RegistryValueKind.String);
                key.SetValue("OpusAliasModel", opusAlias, RegistryValueKind.String);
                key.SetValue("OpusTargetModel", opusTarget, RegistryValueKind.String);
                key.SetValue("HaikuAliasModel", haikuAlias, RegistryValueKind.String);
                key.SetValue("HaikuTargetModel", haikuTarget, RegistryValueKind.String);
                key.SetValue("MinimizeToTray", _minimizeToTrayCheck.IsChecked == true ? 1 : 0, RegistryValueKind.DWord);
                key.SetValue("AutoStart", _autoStartCheck.IsChecked == true ? 1 : 0, RegistryValueKind.DWord);
                key.SetValue("ProxyApiKey", ProtectSecret(_gatewayApiKey), RegistryValueKind.String);
                if (includeApiKey && !string.IsNullOrWhiteSpace(_apiKeyBox.Password))
                    key.SetValue("ApiKey", ProtectSecret(_apiKeyBox.Password), RegistryValueKind.String);
            }
            return true;
        }

        private void SaveGatewaySecuritySettings()
        {
            using (var key = Registry.CurrentUser.CreateSubKey(AppRegistryPath))
            {
                key.SetValue("ProxyApiKey", ProtectSecret(_gatewayApiKey), RegistryValueKind.String);
            }
            UpdateGatewayKeySummary();
        }

        private static string ProtectSecret(string value)
        {
            var plain = Encoding.UTF8.GetBytes(value);
            var encrypted = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
            Array.Clear(plain, 0, plain.Length);
            return Convert.ToBase64String(encrypted);
        }

        private static string UnprotectSecret(string value)
        {
            var encrypted = Convert.FromBase64String(value);
            var plain = ProtectedData.Unprotect(encrypted, null, DataProtectionScope.CurrentUser);
            try { return Encoding.UTF8.GetString(plain); }
            finally { Array.Clear(plain, 0, plain.Length); }
        }

        private void ApplyWindowsAutoStart(bool enabled)
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(RunRegistryPath, true))
                {
                    if (enabled)
                        key.SetValue(RunValueName, QuoteArgument(Process.GetCurrentProcess().MainModule.FileName) + " --autostart", RegistryValueKind.String);
                    else
                        key.DeleteValue(RunValueName, false);
                }
            }
            catch (Exception exception)
            {
                _autoStartCheck.IsChecked = !enabled;
                MessageBox.Show("无法修改开机启动设置：" + exception.Message, "设置失败", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private bool TryGetPort(out int port)
        {
            if (!TryGetPortSilently(out port))
            {
                MessageBox.Show("端口必须是 1 到 65535 之间的整数。", "端口无效", MessageBoxButton.OK, MessageBoxImage.Warning);
                _portBox.Focus();
                return false;
            }
            return true;
        }

        private bool TryGetPortSilently(out int port)
        {
            return int.TryParse(_portBox.Text, out port) && port >= 1 && port <= 65535;
        }

        private bool TryGetModelMapping(
            out string opusAlias,
            out string opusTarget,
            out string sonnetAlias,
            out string sonnetTarget,
            out string haikuAlias,
            out string haikuTarget)
        {
            opusAlias = (_opusAliasBox.Text ?? "").Trim();
            opusTarget = (_opusTargetBox.Text ?? "").Trim();
            sonnetAlias = (_sonnetAliasBox.Text ?? "").Trim();
            sonnetTarget = (_sonnetTargetBox.Text ?? "").Trim();
            haikuAlias = (_haikuAliasBox.Text ?? "").Trim();
            haikuTarget = (_haikuTargetBox.Text ?? "").Trim();
            const string pattern = "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$";

            if (!Regex.IsMatch(sonnetAlias, pattern))
            {
                ShowInvalidModelId("Sonnet 的 Claude 模型 ID", _sonnetAliasBox);
                return false;
            }
            if (!Regex.IsMatch(sonnetTarget, pattern))
            {
                ShowInvalidModelId("Sonnet 的 DeepSeek 模型 ID", _sonnetTargetBox);
                return false;
            }
            if (!Regex.IsMatch(opusAlias, pattern))
            {
                ShowInvalidModelId("Opus 的 Claude 模型 ID", _opusAliasBox);
                return false;
            }
            if (!Regex.IsMatch(opusTarget, pattern))
            {
                ShowInvalidModelId("Opus 的 DeepSeek 模型 ID", _opusTargetBox);
                return false;
            }
            if (!Regex.IsMatch(haikuAlias, pattern))
            {
                ShowInvalidModelId("Haiku 的 Claude 模型 ID", _haikuAliasBox);
                return false;
            }
            if (!Regex.IsMatch(haikuTarget, pattern))
            {
                ShowInvalidModelId("Haiku 的 DeepSeek 模型 ID", _haikuTargetBox);
                return false;
            }
            if (string.Equals(sonnetAlias, opusAlias, StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show("三条映射的 Claude 模型 ID 不能重复。", "模型映射无效",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                _opusAliasBox.Focus();
                return false;
            }
            if (string.Equals(haikuAlias, sonnetAlias, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(haikuAlias, opusAlias, StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show("三条映射的 Claude 模型 ID 不能重复。", "模型映射无效",
                    MessageBoxButton.OK, MessageBoxImage.Warning);
                _haikuAliasBox.Focus();
                return false;
            }
            return true;
        }

        private static void ShowInvalidModelId(string label, TextBox box)
        {
            MessageBox.Show(label + " 无效。只能使用字母、数字、点、下划线、冒号、斜杠和连字符。",
                "模型映射无效", MessageBoxButton.OK, MessageBoxImage.Warning);
            box.Focus();
        }

        private static string BuildModelMapJson(
            string opusAlias,
            string opusTarget,
            string sonnetAlias,
            string sonnetTarget,
            string haikuAlias,
            string haikuTarget)
        {
            return "{\"" + opusAlias + "\":\"" + opusTarget +
                "\",\"" + sonnetAlias + "\":\"" + sonnetTarget +
                "\",\"" + haikuAlias + "\":\"" + haikuTarget + "\"}";
        }

        private static string FindProxyScript(string appDirectory)
        {
            var local = Path.Combine(appDirectory, "claude-deepseek-proxy.mjs");
            if (File.Exists(local)) return local;
            var parent = Directory.GetParent(appDirectory);
            if (parent != null)
            {
                var parentFile = Path.Combine(parent.FullName, "claude-deepseek-proxy.mjs");
                if (File.Exists(parentFile)) return parentFile;
            }
            return local;
        }

        private static string FindNodeExecutable()
        {
            var candidates = new[]
            {
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenAI", "Codex", "bin", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
            };
            foreach (var candidate in candidates)
                if (!string.IsNullOrEmpty(candidate) && File.Exists(candidate)) return candidate;

            var path = Environment.GetEnvironmentVariable("PATH") ?? "";
            foreach (var directory in path.Split(Path.PathSeparator))
            {
                try
                {
                    var candidate = Path.Combine(directory.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return "";
        }

        private static string GetNodeVersion(string nodePath)
        {
            try
            {
                var info = new ProcessStartInfo(nodePath, "--version");
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                using (var process = Process.Start(info))
                {
                    var output = process.StandardOutput.ReadToEnd().Trim();
                    process.WaitForExit(3000);
                    return output;
                }
            }
            catch { return "unknown"; }
        }

        private static bool TryParseNodeMajor(string version, out int major)
        {
            major = 0;
            if (string.IsNullOrEmpty(version)) return false;
            version = version.TrimStart('v', 'V');
            return int.TryParse(version.Split('.')[0], out major);
        }

        private static string CreateGatewayApiKey()
        {
            var bytes = new byte[32];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
            return Convert.ToBase64String(bytes);
        }

        private void OpenAppFolder()
        {
            Process.Start(new ProcessStartInfo(Path.GetDirectoryName(_proxyScriptPath) ?? _appDirectory) { UseShellExecute = true });
        }

        private void UpdateConfigurationPreview()
        {
            int port;
            var endpoint = TryGetPortSilently(out port) ? "http://127.0.0.1:" + port : "http://127.0.0.1:<端口>";
            if (_endpointText != null) _endpointText.Text = endpoint;
        }

        private void CopyEndpoint()
        {
            int port;
            if (!TryGetPort(out port)) return;
            try
            {
                Clipboard.SetText("http://127.0.0.1:" + port);
                ShowTransientStatus("地址已复制", "本地 Gateway 地址已复制到剪贴板。", StatusKind.Success);
            }
            catch (Exception exception)
            {
                MessageBox.Show("无法复制地址：" + exception.Message, "复制失败", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private void UpdateGatewayKeySummary()
        {
            if (_gatewayKeySummaryText == null) return;
            _gatewayKeySummaryText.Text = "已安全配置 · 请求必须携带密钥";
            _gatewayKeySummaryText.Foreground = new SolidColorBrush(Color.FromRgb(31, 138, 94));
        }

        private void CopyGatewayKey()
        {
            try
            {
                Clipboard.SetText(_gatewayApiKey);
                ShowTransientStatus("访问密钥已复制", "请仅粘贴到受信任的本机客户端。", StatusKind.Success);
            }
            catch (Exception exception)
            {
                MessageBox.Show("无法复制 Gateway API Key：" + exception.Message,
                    "复制失败", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }

        private async Task ShowGatewayKeyManagerAsync()
        {
            var root = (FrameworkElement)XamlReader.Parse(GatewayKeyWindowXaml);
            var dialog = new Window
            {
                Title = "Gateway 访问密钥",
                Width = 560,
                Height = 360,
                MinWidth = 560,
                MinHeight = 360,
                MaxWidth = 560,
                MaxHeight = 360,
                ResizeMode = ResizeMode.NoResize,
                WindowStartupLocation = WindowStartupLocation.CenterOwner,
                Owner = this,
                Background = new SolidColorBrush(Color.FromRgb(246, 248, 252)),
                FontFamily = new FontFamily("Microsoft YaHei UI"),
                FontSize = 13,
                Content = root,
                Icon = Icon,
                ShowInTaskbar = false
            };

            var keyBox = (PasswordBox)root.FindName("GatewayKeyBox");
            var saveButton = (Button)root.FindName("SaveGatewayKeyButton");
            var cancelButton = (Button)root.FindName("CancelGatewayKeyButton");
            var generateButton = (Button)root.FindName("GenerateGatewayKeyButton");
            var copyButton = (Button)root.FindName("CopyGatewayKeyDialogButton");
            var restartAfterSave = false;

            keyBox.Password = _gatewayApiKey;

            generateButton.Click += delegate
            {
                keyBox.Password = CreateGatewayApiKey();
                keyBox.Focus();
                keyBox.SelectAll();
            };
            copyButton.Click += delegate
            {
                try { Clipboard.SetText(keyBox.Password); }
                catch (Exception exception)
                {
                    MessageBox.Show(dialog, "无法复制访问密钥：" + exception.Message,
                        "复制失败", MessageBoxButton.OK, MessageBoxImage.Warning);
                }
            };
            cancelButton.Click += delegate { dialog.DialogResult = false; };
            saveButton.Click += delegate
            {
                var value = (keyBox.Password ?? "").Trim();
                if (value.Length < 16 || value.Length > 256 || Regex.IsMatch(value, "[\\x00-\\x1F\\x7F]"))
                {
                    MessageBox.Show(dialog, "Gateway API Key 必须为 16–256 个可见字符。",
                        "访问密钥无效", MessageBoxButton.OK, MessageBoxImage.Warning);
                    keyBox.Focus();
                    return;
                }

                var changed = !string.Equals(value, _gatewayApiKey, StringComparison.Ordinal);
                var ownedRunning = _proxyProcess != null && !_proxyProcess.HasExited;
                if (changed && ownedRunning)
                {
                    var answer = MessageBox.Show(dialog,
                        "访问安全设置变更后，正在运行的代理必须重启。是否保存并立即重启？",
                        "需要重新启动代理", MessageBoxButton.YesNo, MessageBoxImage.Question);
                    if (answer != MessageBoxResult.Yes) return;
                    restartAfterSave = true;
                }

                _gatewayApiKey = value;
                SaveGatewaySecuritySettings();
                dialog.DialogResult = true;
            };

            var saved = dialog.ShowDialog() == true;
            if (!saved) return;

            if (restartAfterSave)
            {
                await RestartProxyAsync();
                return;
            }

            if (_externalProxyDetected)
            {
                MessageBox.Show(this,
                    "设置已经保存，但当前代理不是由本管理器启动。新的访问密钥将在下次由本管理器启动代理时生效。",
                    "设置已保存", MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                ShowTransientStatus("Gateway 设置已保存",
                    "所有本机请求都必须携带访问密钥。", StatusKind.Success);
            }
        }

        private void ShowFromTray()
        {
            Show();
            WindowState = WindowState.Normal;
            UpdatePollingCadence();
            Activate();
            Topmost = true;
            Topmost = false;
            Focus();
        }

        private void ExitApplication()
        {
            _exiting = true;
            Close();
        }

        private void SetStatus(StatusKind kind, string title, string detail)
        {
            if (_lastStatusKind == kind && _lastStatusTitle == title && _lastStatusDetail == detail) return;
            _lastStatusKind = kind;
            _lastStatusTitle = title;
            _lastStatusDetail = detail;
            unchecked { _statusGeneration++; }
            _statusText.Text = title;
            _statusDetail.Text = detail;
            if (_proxyStateTitle != null) _proxyStateTitle.Text = title;
            SolidColorBrush statusBrush;
            switch (kind)
            {
                case StatusKind.Success:
                    statusBrush = SuccessBrush;
                    break;
                case StatusKind.Starting:
                    statusBrush = StartingBrush;
                    break;
                case StatusKind.Error:
                    statusBrush = ErrorBrush;
                    break;
                default:
                    statusBrush = StoppedBrush;
                    break;
            }
            _statusDot.Fill = statusBrush;
            if (_centerStatusDot != null) _centerStatusDot.Fill = statusBrush;
            var trayText = Shorten("DeepSeek 代理 - " + title, 63);
            if (_trayIcon.Text != trayText) _trayIcon.Text = trayText;
        }

        private async void ShowTransientStatus(string title, string detail, StatusKind kind)
        {
            SetStatus(kind, title, detail);
            var generation = _statusGeneration;
            await Task.Delay(1800);
            if (generation != _statusGeneration) return;
            await RefreshHealthAsync();
        }

        private void UpdateButtonState(bool running, bool owned)
        {
            if (_lastRunningState != running || _lastOwnedState != owned)
            {
                _lastRunningState = running;
                _lastOwnedState = owned;
                _startButton.IsEnabled = !running;
                _stopButton.IsEnabled = running && owned;
                _restartButton.IsEnabled = running && owned;
                _trayStartItem.Enabled = !running;
                _trayStopItem.Enabled = running && owned;
                _portBox.IsEnabled = !running;
                _sonnetAliasBox.IsEnabled = !running;
                _sonnetTargetBox.IsEnabled = !running;
                _opusAliasBox.IsEnabled = !running;
                _opusTargetBox.IsEnabled = !running;
                _haikuAliasBox.IsEnabled = !running;
                _haikuTargetBox.IsEnabled = !running;
            }
            var nodeText = string.IsNullOrEmpty(_nodePath)
                ? "Node.js 将在启动时自动检测"
                : "Node.js " + (string.IsNullOrEmpty(_nodeVersion) ? "已检测" : _nodeVersion) + " · 已就绪";
            if (_nodeText.Text != nodeText) _nodeText.Text = nodeText;
        }

        private void ReleaseExitedProxyProcess()
        {
            if (_proxyProcess == null) return;
            try
            {
                if (!_proxyProcess.HasExited) return;
            }
            catch
            {
                return;
            }

            var exited = _proxyProcess;
            _proxyProcess = null;
            exited.Dispose();
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static bool TryRequestGracefulShutdown(Process process, string reason)
        {
            try
            {
                if (process == null || process.HasExited) return true;
                var safeReason = Regex.Replace(reason ?? "manager_request", "[^a-zA-Z0-9_.-]", "_");
                process.StandardInput.WriteLine("{\"command\":\"shutdown\",\"reason\":\"" + safeReason + "\"}");
                process.StandardInput.Flush();
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string Shorten(string value, int maximum)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maximum) return value;
            return value.Substring(0, maximum - 1) + "…";
        }

        private static SolidColorBrush CreateFrozenBrush(byte red, byte green, byte blue)
        {
            var brush = new SolidColorBrush(Color.FromRgb(red, green, blue));
            brush.Freeze();
            return brush;
        }

        private enum StatusKind { Stopped, Starting, Success, Error }

        private const string WindowXaml = @"
<Grid xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
      xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"" Background=""#F6F8FC"" Language=""zh-CN""
      UseLayoutRounding=""True"" SnapsToDevicePixels=""True"" RenderOptions.ClearTypeHint=""Enabled""
      TextElement.FontFamily=""Microsoft YaHei UI"" TextElement.FontSize=""13""
      TextOptions.TextFormattingMode=""Display"" TextOptions.TextRenderingMode=""ClearType"" TextOptions.TextHintingMode=""Fixed"">
  <Grid.Resources>
    <SolidColorBrush x:Key=""Ink"" Color=""#263449""/>
    <SolidColorBrush x:Key=""Muted"" Color=""#748096""/>
    <SolidColorBrush x:Key=""Primary"" Color=""#4B76E5""/>
    <Style x:Key=""DisplayText"" TargetType=""TextBlock""><Setter Property=""FontSize"" Value=""22""/><Setter Property=""FontWeight"" Value=""SemiBold""/></Style>
    <Style x:Key=""HeroText"" TargetType=""TextBlock""><Setter Property=""FontSize"" Value=""20""/><Setter Property=""FontWeight"" Value=""SemiBold""/></Style>
    <Style x:Key=""SectionTitleText"" TargetType=""TextBlock""><Setter Property=""FontSize"" Value=""16""/><Setter Property=""FontWeight"" Value=""SemiBold""/></Style>
    <Style x:Key=""SubsectionTitleText"" TargetType=""TextBlock""><Setter Property=""FontSize"" Value=""14""/><Setter Property=""FontWeight"" Value=""SemiBold""/></Style>
    <Style x:Key=""SecondaryText"" TargetType=""TextBlock""><Setter Property=""FontSize"" Value=""12""/><Setter Property=""FontWeight"" Value=""Normal""/></Style>
    <Style x:Key=""CaptionText"" TargetType=""TextBlock""><Setter Property=""FontSize"" Value=""11""/><Setter Property=""FontWeight"" Value=""Normal""/></Style>
    <Style x:Key=""MonoValueText"" TargetType=""TextBlock""><Setter Property=""FontFamily"" Value=""Consolas""/><Setter Property=""FontSize"" Value=""13""/><Setter Property=""FontWeight"" Value=""Normal""/></Style>
    <Style x:Key=""Card"" TargetType=""Border"">
      <Setter Property=""Background"" Value=""White""/><Setter Property=""CornerRadius"" Value=""12""/>
      <Setter Property=""BorderBrush"" Value=""#DDE5F0""/><Setter Property=""BorderThickness"" Value=""1""/>
    </Style>
    <Style x:Key=""ButtonFocusVisual"" TargetType=""{x:Type Control}"">
      <Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""{x:Type Control}"">
        <Border Margin=""1"" BorderBrush=""#7897ED"" BorderThickness=""2"" CornerRadius=""9""/>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType=""TextBox"">
      <Setter Property=""Height"" Value=""40""/><Setter Property=""Padding"" Value=""10,0""/>
      <Setter Property=""FontSize"" Value=""13""/>
      <Setter Property=""Foreground"" Value=""#263449""/><Setter Property=""Background"" Value=""White""/>
      <Setter Property=""BorderBrush"" Value=""#D7E0EC""/><Setter Property=""BorderThickness"" Value=""1""/>
      <Setter Property=""VerticalContentAlignment"" Value=""Center""/><Setter Property=""Template""><Setter.Value>
        <ControlTemplate TargetType=""TextBox""><Border x:Name=""InputBorder"" Background=""{TemplateBinding Background}"" BorderBrush=""{TemplateBinding BorderBrush}"" BorderThickness=""{TemplateBinding BorderThickness}"" CornerRadius=""7"">
          <ScrollViewer x:Name=""PART_ContentHost"" Margin=""{TemplateBinding Padding}"" VerticalAlignment=""Center""/>
        </Border><ControlTemplate.Triggers>
          <Trigger Property=""IsKeyboardFocused"" Value=""True""><Setter TargetName=""InputBorder"" Property=""BorderBrush"" Value=""#6B86E8""/><Setter TargetName=""InputBorder"" Property=""BorderThickness"" Value=""1.5""/></Trigger>
          <Trigger Property=""IsEnabled"" Value=""False""><Setter TargetName=""InputBorder"" Property=""Background"" Value=""#F5F7FA""/><Setter Property=""Foreground"" Value=""#98A2B3""/></Trigger>
        </ControlTemplate.Triggers></ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style x:Key=""TechnicalInput"" TargetType=""TextBox"" BasedOn=""{StaticResource {x:Type TextBox}}"">
      <Setter Property=""FontFamily"" Value=""Consolas""/><Setter Property=""FontSize"" Value=""12""/>
    </Style>
    <Style TargetType=""PasswordBox"">
      <Setter Property=""Height"" Value=""40""/><Setter Property=""Padding"" Value=""10,0""/>
      <Setter Property=""FontSize"" Value=""13""/>
      <Setter Property=""Foreground"" Value=""#263449""/><Setter Property=""Background"" Value=""White""/>
      <Setter Property=""BorderBrush"" Value=""#D7E0EC""/><Setter Property=""BorderThickness"" Value=""1""/><Setter Property=""VerticalContentAlignment"" Value=""Center""/>
      <Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""PasswordBox"">
        <Border x:Name=""InputBorder"" Background=""{TemplateBinding Background}"" BorderBrush=""{TemplateBinding BorderBrush}"" BorderThickness=""{TemplateBinding BorderThickness}"" CornerRadius=""7"">
          <ScrollViewer x:Name=""PART_ContentHost"" Margin=""{TemplateBinding Padding}"" VerticalAlignment=""Center""/>
        </Border><ControlTemplate.Triggers>
          <Trigger Property=""IsKeyboardFocused"" Value=""True""><Setter TargetName=""InputBorder"" Property=""BorderBrush"" Value=""#6B86E8""/><Setter TargetName=""InputBorder"" Property=""BorderThickness"" Value=""1.5""/></Trigger>
          <Trigger Property=""IsEnabled"" Value=""False""><Setter TargetName=""InputBorder"" Property=""Background"" Value=""#F5F7FA""/></Trigger>
        </ControlTemplate.Triggers></ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style x:Key=""PrimaryButton"" TargetType=""Button"">
      <Setter Property=""Foreground"" Value=""White""/><Setter Property=""Background"" Value=""#4B76E5""/>
      <Setter Property=""BorderThickness"" Value=""0""/><Setter Property=""Padding"" Value=""18,9""/><Setter Property=""MinHeight"" Value=""38""/>
      <Setter Property=""FontSize"" Value=""13""/><Setter Property=""FontWeight"" Value=""SemiBold""/><Setter Property=""Cursor"" Value=""Hand""/><Setter Property=""FocusVisualStyle"" Value=""{StaticResource ButtonFocusVisual}""/>
      <Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""Button"">
        <Border Background=""{TemplateBinding Background}"" CornerRadius=""8"" Padding=""{TemplateBinding Padding}""><ContentPresenter HorizontalAlignment=""Center"" VerticalAlignment=""Center""/></Border>
        <ControlTemplate.Triggers><Trigger Property=""IsMouseOver"" Value=""True""><Setter Property=""Background"" Value=""#3E68D5""/></Trigger><Trigger Property=""IsPressed"" Value=""True""><Setter Property=""Background"" Value=""#345BC4""/></Trigger><Trigger Property=""IsEnabled"" Value=""False""><Setter Property=""Opacity"" Value=""0.48""/><Setter Property=""Cursor"" Value=""Arrow""/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key=""SecondaryButton"" TargetType=""Button"" BasedOn=""{StaticResource PrimaryButton}"">
      <Setter Property=""Foreground"" Value=""#42526B""/><Setter Property=""Background"" Value=""#F5F7FC""/>
      <Setter Property=""BorderBrush"" Value=""#D9E2F1""/><Setter Property=""BorderThickness"" Value=""1""/>
      <Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""Button"">
        <Border Background=""{TemplateBinding Background}"" BorderBrush=""{TemplateBinding BorderBrush}"" BorderThickness=""{TemplateBinding BorderThickness}"" CornerRadius=""8"" Padding=""{TemplateBinding Padding}""><ContentPresenter HorizontalAlignment=""Center"" VerticalAlignment=""Center""/></Border>
        <ControlTemplate.Triggers><Trigger Property=""IsMouseOver"" Value=""True""><Setter Property=""Background"" Value=""#EDF2FA""/></Trigger><Trigger Property=""IsPressed"" Value=""True""><Setter Property=""Background"" Value=""#E2EAF6""/></Trigger><Trigger Property=""IsEnabled"" Value=""False""><Setter Property=""Opacity"" Value=""0.48""/><Setter Property=""Cursor"" Value=""Arrow""/></Trigger></ControlTemplate.Triggers>
      </ControlTemplate></Setter.Value></Setter>
    </Style>
  </Grid.Resources>
  <Grid>
    <Grid.RowDefinitions><RowDefinition Height=""88""/><RowDefinition Height=""*""/><RowDefinition Height=""48""/></Grid.RowDefinitions>
    <Border Grid.Row=""0"" Background=""#FAFBFD"" BorderBrush=""#E3E8F0"" BorderThickness=""0,0,0,1"" Padding=""26,0"">
      <Grid><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions>
        <StackPanel Orientation=""Horizontal"" VerticalAlignment=""Center"">
          <Image x:Name=""HeaderIcon"" Width=""48"" Height=""48"" Stretch=""None"" RenderOptions.BitmapScalingMode=""HighQuality"" Margin=""0,0,15,0""/>
          <StackPanel VerticalAlignment=""Center""><TextBlock Text=""DeepSeek Claude Proxy"" Foreground=""#1F2A3D"" Style=""{StaticResource DisplayText}""/>
            <TextBlock Text=""本地模型路由与代理管理"" Foreground=""#748096"" Margin=""0,4,0,0"" Style=""{StaticResource SecondaryText}""/></StackPanel>
        </StackPanel>
        <Border Grid.Column=""1"" Background=""#F6F8FC"" BorderBrush=""#DCE4F2"" BorderThickness=""1"" CornerRadius=""18"" Padding=""14,8"" VerticalAlignment=""Center"">
          <StackPanel Orientation=""Horizontal""><Ellipse x:Name=""StatusDot"" Width=""9"" Height=""9"" Fill=""#5B7FE6"" Margin=""0,0,8,0""/>
            <TextBlock x:Name=""StatusText"" Text=""正在检查"" Foreground=""#344054"" FontWeight=""SemiBold""/></StackPanel>
        </Border>
      </Grid>
    </Border>
    <Grid Grid.Row=""1"" Margin=""24,18,24,16"">
      <Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""18""/><ColumnDefinition Width=""*""/></Grid.ColumnDefinitions>
      <Border Grid.Column=""0"" Style=""{StaticResource Card}"" Padding=""22"">
        <Grid><Grid.RowDefinitions><RowDefinition Height=""Auto""/><RowDefinition Height=""*""/><RowDefinition Height=""Auto""/></Grid.RowDefinitions>
          <StackPanel><TextBlock Text=""代理配置"" Foreground=""{StaticResource Ink}"" Style=""{StaticResource SectionTitleText}""/>
            <TextBlock Text=""密钥与映射只保存在当前 Windows 账户"" Foreground=""{StaticResource Muted}"" Style=""{StaticResource SecondaryText}"" Margin=""0,5,0,0""/></StackPanel>
          <ScrollViewer Grid.Row=""1"" VerticalScrollBarVisibility=""Auto"" HorizontalScrollBarVisibility=""Disabled"" PanningMode=""VerticalOnly"" Margin=""0,4,0,4"">
            <StackPanel Margin=""0,0,4,0"">
              <TextBlock Text=""DeepSeek API Key"" Foreground=""{StaticResource Muted}"" Margin=""0,2,0,5""/>
              <Grid><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""9""/><ColumnDefinition Width=""92""/></Grid.ColumnDefinitions>
                <PasswordBox x:Name=""ApiKeyBox"" AutomationProperties.Name=""DeepSeek API Key""/><Button x:Name=""SaveKeyButton"" Grid.Column=""2"" Content=""保存配置"" Style=""{StaticResource SecondaryButton}"" Padding=""12,8""/>
              </Grid>
              <TextBlock Text=""使用 Windows DPAPI 加密，不会出现在命令行参数中"" Foreground=""#7D889A"" Style=""{StaticResource CaptionText}"" Margin=""0,5,0,0""/>
              <TextBlock Text=""本地监听端口"" Foreground=""{StaticResource Muted}"" Margin=""0,10,0,5""/>
              <TextBox x:Name=""PortBox"" Text=""3210"" Style=""{StaticResource TechnicalInput}"" AutomationProperties.Name=""本地监听端口""/>
              <Grid Margin=""0,12,0,5""><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions>
                <TextBlock Text=""模型映射"" Foreground=""{StaticResource Ink}"" Style=""{StaticResource SubsectionTitleText}""/>
                <TextBlock Grid.Column=""1"" Text=""三组均可编辑"" Foreground=""#5E7DD8"" Style=""{StaticResource CaptionText}""/>
              </Grid>
              <Border Background=""#F8FAFD"" CornerRadius=""9"" Padding=""10"" BorderBrush=""#E1E7F0"" BorderThickness=""1"">
                <Grid>
                  <Grid.RowDefinitions><RowDefinition Height=""Auto""/><RowDefinition Height=""6""/><RowDefinition Height=""Auto""/><RowDefinition Height=""7""/><RowDefinition Height=""Auto""/><RowDefinition Height=""7""/><RowDefinition Height=""Auto""/></Grid.RowDefinitions>
                  <Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""32""/><ColumnDefinition Width=""*""/></Grid.ColumnDefinitions>
                  <TextBlock Text=""Claude 模型 ID"" Foreground=""#6F7C90"" Style=""{StaticResource CaptionText}""/>
                  <TextBlock Grid.Column=""2"" Text=""DeepSeek 模型 ID"" Foreground=""#6F7C90"" Style=""{StaticResource CaptionText}""/>
                  <TextBox x:Name=""SonnetAliasBox"" Grid.Row=""2"" Text=""claude-sonnet-4-5"" Style=""{StaticResource TechnicalInput}"" Padding=""8,0"" AutomationProperties.Name=""Sonnet Claude 模型 ID""/>
                  <TextBlock Grid.Row=""2"" Grid.Column=""1"" Text=""→"" Foreground=""#6B86E8"" FontSize=""16"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                  <TextBox x:Name=""SonnetTargetBox"" Grid.Row=""2"" Grid.Column=""2"" Text=""deepseek-v4-flash"" Style=""{StaticResource TechnicalInput}"" Padding=""8,0"" AutomationProperties.Name=""Sonnet DeepSeek 模型 ID""/>
                  <TextBox x:Name=""OpusAliasBox"" Grid.Row=""4"" Text=""claude-opus-4-5"" Style=""{StaticResource TechnicalInput}"" Padding=""8,0"" AutomationProperties.Name=""Opus Claude 模型 ID""/>
                  <TextBlock Grid.Row=""4"" Grid.Column=""1"" Text=""→"" Foreground=""#6B86E8"" FontSize=""16"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                  <TextBox x:Name=""OpusTargetBox"" Grid.Row=""4"" Grid.Column=""2"" Text=""deepseek-v4-pro"" Style=""{StaticResource TechnicalInput}"" Padding=""8,0"" AutomationProperties.Name=""Opus DeepSeek 模型 ID""/>
                  <TextBox x:Name=""HaikuAliasBox"" Grid.Row=""6"" Text=""claude-haiku-4-5"" Style=""{StaticResource TechnicalInput}"" Padding=""8,0"" AutomationProperties.Name=""Haiku Claude 模型 ID""/>
                  <TextBlock Grid.Row=""6"" Grid.Column=""1"" Text=""→"" Foreground=""#6B86E8"" FontSize=""16"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/>
                  <TextBox x:Name=""HaikuTargetBox"" Grid.Row=""6"" Grid.Column=""2"" Text=""deepseek-v4-flash"" Style=""{StaticResource TechnicalInput}"" Padding=""8,0"" AutomationProperties.Name=""Haiku DeepSeek 模型 ID""/>
                </Grid>
              </Border>
            </StackPanel>
          </ScrollViewer>
          <Border Grid.Row=""2"" BorderBrush=""#E8ECF2"" BorderThickness=""0,1,0,0"" Padding=""0,12,0,0"">
            <StackPanel><CheckBox x:Name=""AutoStartCheck"" Content=""登录 Windows 后自动启动代理"" Foreground=""#344054""/>
              <CheckBox x:Name=""MinimizeToTrayCheck"" Content=""关闭窗口时最小化到托盘"" Foreground=""#344054"" Margin=""0,9,0,0""/></StackPanel>
          </Border>
        </Grid>
      </Border>
      <Border Grid.Column=""2"" Style=""{StaticResource Card}"" Padding=""0"">
        <Grid>
          <Grid.RowDefinitions>
            <RowDefinition Height=""190""/><RowDefinition Height=""1""/><RowDefinition Height=""118""/>
            <RowDefinition Height=""1""/><RowDefinition Height=""78""/><RowDefinition Height=""1""/><RowDefinition Height=""*""/>
          </Grid.RowDefinitions>
          <Border Grid.Row=""0"" CornerRadius=""12,12,0,0"" Background=""#FAFCFF"" Padding=""26,22"">
            <Grid><Grid.RowDefinitions><RowDefinition Height=""Auto""/><RowDefinition Height=""*""/><RowDefinition Height=""Auto""/></Grid.RowDefinitions>
              <Grid><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions>
                <TextBlock Text=""运行中心"" Foreground=""{StaticResource Ink}"" Style=""{StaticResource SectionTitleText}""/>
                <Border Grid.Column=""1"" Background=""#EEF3FD"" CornerRadius=""12"" Padding=""10,4""><TextBlock Text=""本机模式"" Foreground=""#5575CD"" Style=""{StaticResource CaptionText}"" FontWeight=""SemiBold""/></Border>
              </Grid>
              <Grid Grid.Row=""1"" Margin=""0,12,0,10""><Grid.ColumnDefinitions><ColumnDefinition Width=""54""/><ColumnDefinition Width=""*""/></Grid.ColumnDefinitions>
                <Border Width=""46"" Height=""46"" CornerRadius=""23"" Background=""#EDF2FB"" HorizontalAlignment=""Left"" VerticalAlignment=""Center""><Ellipse x:Name=""CenterStatusDot"" Width=""13"" Height=""13"" Fill=""#6F92E8"" HorizontalAlignment=""Center"" VerticalAlignment=""Center""/></Border>
                <StackPanel Grid.Column=""1"" VerticalAlignment=""Center"">
                  <TextBlock x:Name=""ProxyStateTitle"" Text=""正在检查"" Foreground=""#172033"" Style=""{StaticResource HeroText}""/>
                  <TextBlock x:Name=""StatusDetail"" Text=""正在检查本地代理…"" Foreground=""{StaticResource Muted}"" Style=""{StaticResource SecondaryText}"" Margin=""0,5,10,0"" TextWrapping=""Wrap"" LineHeight=""18""/>
                </StackPanel>
              </Grid>
              <Grid Grid.Row=""2""><Grid.ColumnDefinitions><ColumnDefinition Width=""1.35*""/><ColumnDefinition Width=""8""/><ColumnDefinition Width=""*""/><ColumnDefinition Width=""8""/><ColumnDefinition Width=""*""/></Grid.ColumnDefinitions>
                <Button x:Name=""StartButton"" Content=""启动代理"" Style=""{StaticResource PrimaryButton}""/>
                <Button x:Name=""StopButton"" Grid.Column=""2"" Content=""停止"" Style=""{StaticResource SecondaryButton}"" IsEnabled=""False""/>
                <Button x:Name=""RestartButton"" Grid.Column=""4"" Content=""重新启动"" Style=""{StaticResource SecondaryButton}"" IsEnabled=""False""/>
              </Grid>
            </Grid>
          </Border>
          <Border Grid.Row=""1"" Background=""#E7ECF3""/>
          <Grid Grid.Row=""2"" Margin=""26,14""><Grid.RowDefinitions><RowDefinition Height=""40""/><RowDefinition Height=""8""/><RowDefinition Height=""40""/></Grid.RowDefinitions>
            <Grid.ColumnDefinitions><ColumnDefinition Width=""76""/><ColumnDefinition Width=""*""/><ColumnDefinition Width=""10""/><ColumnDefinition Width=""54""/><ColumnDefinition Width=""8""/><ColumnDefinition Width=""54""/></Grid.ColumnDefinitions>
            <StackPanel Grid.Row=""0"" VerticalAlignment=""Center""><TextBlock Text=""本地端点"" Foreground=""#344054"" FontWeight=""SemiBold""/><TextBlock Text=""Gateway URL"" Foreground=""#8792A5"" Style=""{StaticResource CaptionText}"" Margin=""0,2,0,0""/></StackPanel>
            <Border Grid.Row=""0"" Grid.Column=""1"" Grid.ColumnSpan=""3"" Background=""#F8FAFD"" CornerRadius=""7"" BorderBrush=""#DDE5F1"" BorderThickness=""1"" MinHeight=""40"" Padding=""12,0"">
              <TextBlock x:Name=""EndpointText"" Text=""http://127.0.0.1:3210"" Foreground=""#5271C7"" Style=""{StaticResource MonoValueText}"" VerticalAlignment=""Center"" TextWrapping=""NoWrap"" TextTrimming=""None""/>
            </Border>
            <Button x:Name=""CopyEndpointButton"" Grid.Row=""0"" Grid.Column=""5"" Content=""复制"" Style=""{StaticResource SecondaryButton}"" Padding=""10,8""/>
            <StackPanel Grid.Row=""2"" VerticalAlignment=""Center""><TextBlock Text=""访问密钥"" Foreground=""#344054"" FontWeight=""SemiBold""/><TextBlock Text=""Gateway Key"" Foreground=""#8792A5"" Style=""{StaticResource CaptionText}"" Margin=""0,2,0,0""/></StackPanel>
            <Border Grid.Row=""2"" Grid.Column=""1"" Background=""#F8FAFD"" CornerRadius=""7"" BorderBrush=""#DDE5F1"" BorderThickness=""1"" MinHeight=""40"" Padding=""12,0"">
              <TextBlock x:Name=""GatewayKeySummaryText"" Text=""正在准备安全密钥…"" Foreground=""#5271C7"" Style=""{StaticResource SecondaryText}"" VerticalAlignment=""Center"" TextTrimming=""CharacterEllipsis""/>
            </Border>
            <Button x:Name=""CopyGatewayKeyButton"" Grid.Row=""2"" Grid.Column=""3"" Content=""复制"" Style=""{StaticResource SecondaryButton}"" Padding=""8,8""/>
            <Button x:Name=""ManageGatewayKeyButton"" Grid.Row=""2"" Grid.Column=""5"" Content=""管理"" Style=""{StaticResource SecondaryButton}"" Padding=""8,8""/>
          </Grid>
          <Border Grid.Row=""3"" Background=""#E7ECF3""/>
          <Grid Grid.Row=""4"" Margin=""26,18""><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""10""/><ColumnDefinition Width=""*""/><ColumnDefinition Width=""10""/><ColumnDefinition Width=""*""/></Grid.ColumnDefinitions>
            <Button x:Name=""TestButton"" Content=""测试连接"" Style=""{StaticResource SecondaryButton}""/>
            <Button x:Name=""OpenLogButton"" Grid.Column=""2"" Content=""运行日志"" Style=""{StaticResource SecondaryButton}""/>
            <Button x:Name=""OpenFolderButton"" Grid.Column=""4"" Content=""程序目录"" Style=""{StaticResource SecondaryButton}""/>
          </Grid>
          <Border Grid.Row=""5"" Background=""#E7ECF3""/>
          <Grid Grid.Row=""6"" Margin=""26,12,26,10""><Grid.RowDefinitions><RowDefinition Height=""Auto""/><RowDefinition Height=""*""/></Grid.RowDefinitions>
            <TextBlock Text=""运行保障"" Foreground=""{StaticResource Ink}"" Style=""{StaticResource SubsectionTitleText}""/>
            <Grid Grid.Row=""1"" Margin=""0,7,0,0""><Grid.RowDefinitions><RowDefinition Height=""24""/><RowDefinition Height=""1""/><RowDefinition Height=""24""/><RowDefinition Height=""1""/><RowDefinition Height=""24""/></Grid.RowDefinitions>
              <Grid><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions><TextBlock Text=""网络范围"" Foreground=""{StaticResource Muted}"" VerticalAlignment=""Center""/><TextBlock Grid.Column=""1"" Text=""仅监听 127.0.0.1"" Foreground=""#344054"" VerticalAlignment=""Center""/></Grid>
              <Border Grid.Row=""1"" Background=""#EEF2F7""/>
              <Grid Grid.Row=""2""><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions><TextBlock Text=""密钥存储"" Foreground=""{StaticResource Muted}"" VerticalAlignment=""Center""/><TextBlock Grid.Column=""1"" Text=""Windows DPAPI 加密"" Foreground=""#344054"" VerticalAlignment=""Center""/></Grid>
              <Border Grid.Row=""3"" Background=""#EEF2F7""/>
              <Grid Grid.Row=""4""><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions><TextBlock Text=""运行记录"" Foreground=""{StaticResource Muted}"" VerticalAlignment=""Center""/><TextBlock Grid.Column=""1"" Text=""独立窗口 · 自动轮换"" Foreground=""#344054"" VerticalAlignment=""Center""/></Grid>
            </Grid>
          </Grid>
        </Grid>
      </Border>
    </Grid>
    <Border Grid.Row=""2"" Background=""#FAFBFD"" BorderBrush=""#E3E8F0"" BorderThickness=""0,1,0,0"" Padding=""24,0"">
      <Grid><TextBlock x:Name=""NodeText"" Text=""Node.js 将在启动时自动检测"" Foreground=""{StaticResource Muted}"" VerticalAlignment=""Center"" Style=""{StaticResource CaptionText}""/>
        <TextBlock Text=""本地安全模式  ·  仅监听 127.0.0.1"" HorizontalAlignment=""Right"" Foreground=""#7A8699"" VerticalAlignment=""Center"" Style=""{StaticResource CaptionText}""/>
      </Grid>
    </Border>
  </Grid>
</Grid>";

        private const string GatewayKeyWindowXaml = @"
<Grid xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
      xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"" Background=""#F6F8FC"" Language=""zh-CN""
      UseLayoutRounding=""True"" SnapsToDevicePixels=""True"" TextOptions.TextFormattingMode=""Display"">
  <Grid.Resources>
    <Style x:Key=""DialogButtonFocusVisual"" TargetType=""{x:Type Control}"">
      <Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""{x:Type Control}""><Border Margin=""1"" BorderBrush=""#7897ED"" BorderThickness=""2"" CornerRadius=""9""/></ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style TargetType=""Button"">
      <Setter Property=""MinHeight"" Value=""38""/><Setter Property=""Padding"" Value=""16,8""/><Setter Property=""Cursor"" Value=""Hand""/>
      <Setter Property=""Foreground"" Value=""#42526B""/><Setter Property=""Background"" Value=""#F5F7FC""/><Setter Property=""BorderBrush"" Value=""#D9E2F1""/><Setter Property=""BorderThickness"" Value=""1""/><Setter Property=""FocusVisualStyle"" Value=""{StaticResource DialogButtonFocusVisual}""/>
      <Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""Button""><Border Background=""{TemplateBinding Background}"" BorderBrush=""{TemplateBinding BorderBrush}"" BorderThickness=""{TemplateBinding BorderThickness}"" CornerRadius=""8"" Padding=""{TemplateBinding Padding}""><ContentPresenter HorizontalAlignment=""Center"" VerticalAlignment=""Center""/></Border><ControlTemplate.Triggers><Trigger Property=""IsMouseOver"" Value=""True""><Setter Property=""Background"" Value=""#EDF2FA""/></Trigger><Trigger Property=""IsPressed"" Value=""True""><Setter Property=""Background"" Value=""#E2EAF6""/></Trigger><Trigger Property=""IsEnabled"" Value=""False""><Setter Property=""Opacity"" Value=""0.48""/><Setter Property=""Cursor"" Value=""Arrow""/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter>
    </Style>
    <Style x:Key=""PrimaryDialogButton"" TargetType=""Button"" BasedOn=""{StaticResource {x:Type Button}}""><Setter Property=""Foreground"" Value=""White""/><Setter Property=""Background"" Value=""#4B76E5""/><Setter Property=""BorderBrush"" Value=""#4B76E5""/><Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""Button""><Border Background=""{TemplateBinding Background}"" BorderBrush=""{TemplateBinding BorderBrush}"" BorderThickness=""{TemplateBinding BorderThickness}"" CornerRadius=""8"" Padding=""{TemplateBinding Padding}""><ContentPresenter HorizontalAlignment=""Center"" VerticalAlignment=""Center""/></Border><ControlTemplate.Triggers><Trigger Property=""IsMouseOver"" Value=""True""><Setter Property=""Background"" Value=""#3E68D5""/></Trigger><Trigger Property=""IsPressed"" Value=""True""><Setter Property=""Background"" Value=""#345BC4""/></Trigger><Trigger Property=""IsEnabled"" Value=""False""><Setter Property=""Opacity"" Value=""0.48""/><Setter Property=""Cursor"" Value=""Arrow""/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
    <Style TargetType=""PasswordBox""><Setter Property=""Height"" Value=""42""/><Setter Property=""Padding"" Value=""11,0""/><Setter Property=""VerticalContentAlignment"" Value=""Center""/><Setter Property=""Foreground"" Value=""#263449""/><Setter Property=""Background"" Value=""White""/><Setter Property=""BorderBrush"" Value=""#D7E0EC""/><Setter Property=""BorderThickness"" Value=""1""/><Setter Property=""Template""><Setter.Value><ControlTemplate TargetType=""PasswordBox""><Border x:Name=""DialogInputBorder"" Background=""{TemplateBinding Background}"" BorderBrush=""{TemplateBinding BorderBrush}"" BorderThickness=""{TemplateBinding BorderThickness}"" CornerRadius=""7""><ScrollViewer x:Name=""PART_ContentHost"" Margin=""{TemplateBinding Padding}"" VerticalAlignment=""Center""/></Border><ControlTemplate.Triggers><Trigger Property=""IsKeyboardFocused"" Value=""True""><Setter TargetName=""DialogInputBorder"" Property=""BorderBrush"" Value=""#6B86E8""/><Setter TargetName=""DialogInputBorder"" Property=""BorderThickness"" Value=""1.5""/></Trigger></ControlTemplate.Triggers></ControlTemplate></Setter.Value></Setter></Style>
  </Grid.Resources>
  <Border Margin=""18"" Background=""White"" BorderBrush=""#E4E9F1"" BorderThickness=""1"" CornerRadius=""12"" Padding=""22""><Grid>
    <Grid.RowDefinitions><RowDefinition Height=""Auto""/><RowDefinition Height=""Auto""/><RowDefinition Height=""Auto""/><RowDefinition Height=""Auto""/><RowDefinition Height=""*""/><RowDefinition Height=""Auto""/></Grid.RowDefinitions>
    <TextBlock Text=""Gateway 访问密钥"" Foreground=""#263449"" FontSize=""18"" FontWeight=""SemiBold""/>
    <TextBlock Grid.Row=""1"" Text=""用于访问本地 Gateway，与 DeepSeek API Key 完全不同。"" Foreground=""#748096"" FontSize=""11.5"" Margin=""0,5,0,0""/>
    <Grid Grid.Row=""2"" Margin=""0,18,0,0""><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""8""/><ColumnDefinition Width=""Auto""/><ColumnDefinition Width=""8""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions>
      <PasswordBox x:Name=""GatewayKeyBox"" AutomationProperties.Name=""Gateway 访问密钥""/>
      <Button x:Name=""GenerateGatewayKeyButton"" Grid.Column=""2"" Content=""随机生成""/>
      <Button x:Name=""CopyGatewayKeyDialogButton"" Grid.Column=""4"" Content=""复制""/>
    </Grid>
    <TextBlock Grid.Row=""3"" Text=""密钥长度必须为 16–256 个字符，并通过 Windows DPAPI 加密保存。"" Foreground=""#8792A5"" FontSize=""10.5"" Margin=""0,7,0,0""/>
    <Border Grid.Row=""4"" Background=""#F3F8F5"" BorderBrush=""#D8EADF"" BorderThickness=""1"" CornerRadius=""8"" Padding=""14,10"" Margin=""0,14,0,14"" VerticalAlignment=""Top""><StackPanel>
      <TextBlock Text=""密钥鉴权已启用"" Foreground=""#1F7A55"" FontWeight=""SemiBold""/>
      <TextBlock Text=""所有本机请求都必须提供 Bearer 或 x-api-key；程序仍然只监听 127.0.0.1。"" Foreground=""#63766D"" FontSize=""10.5"" TextWrapping=""Wrap"" Margin=""0,5,0,0"" LineHeight=""17""/>
    </StackPanel></Border>
    <Grid Grid.Row=""5""><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/><ColumnDefinition Width=""8""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions>
      <TextBlock Text=""始终只监听 127.0.0.1"" Foreground=""#8792A5"" FontSize=""10.5"" VerticalAlignment=""Center""/>
      <Button x:Name=""CancelGatewayKeyButton"" Grid.Column=""1"" Content=""取消""/>
      <Button x:Name=""SaveGatewayKeyButton"" Grid.Column=""3"" Content=""保存设置"" Style=""{StaticResource PrimaryDialogButton}""/>
    </Grid>
  </Grid></Border>
</Grid>";

        private const string LogWindowXaml = @"
<Grid xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
      xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"" Background=""#111827"">
  <Grid.RowDefinitions><RowDefinition Height=""58""/><RowDefinition Height=""*""/></Grid.RowDefinitions>
  <Border Background=""#182234"" BorderBrush=""#2A374B"" BorderThickness=""0,0,0,1"" Padding=""18,0"">
    <Grid><Grid.ColumnDefinitions><ColumnDefinition Width=""*""/><ColumnDefinition Width=""Auto""/></Grid.ColumnDefinitions>
      <StackPanel VerticalAlignment=""Center"">
        <TextBlock Text=""运行日志"" Foreground=""#F2F5F9"" FontSize=""16"" FontWeight=""SemiBold""/>
        <TextBlock Text=""仅显示最近 160 行，日志文件会自动轮换"" Foreground=""#8FA0B7"" FontSize=""11"" Margin=""0,3,0,0""/>
      </StackPanel>
      <StackPanel Grid.Column=""1"" Orientation=""Horizontal"" VerticalAlignment=""Center"">
        <Button x:Name=""OpenLogFolderButton"" Content=""打开目录"" Foreground=""#D6DFEA"" Background=""#263449"" BorderThickness=""0"" Padding=""12,7"" Cursor=""Hand""/>
        <Button x:Name=""ClearLogButton"" Content=""清空日志"" Foreground=""#D6DFEA"" Background=""#263449"" BorderThickness=""0"" Padding=""12,7"" Cursor=""Hand"" Margin=""8,0,0,0""/>
      </StackPanel>
    </Grid>
  </Border>
  <TextBox x:Name=""LogBox"" Grid.Row=""1"" IsReadOnly=""True"" AcceptsReturn=""True"" TextWrapping=""NoWrap""
           VerticalScrollBarVisibility=""Auto"" HorizontalScrollBarVisibility=""Auto"" Background=""#111827"" Foreground=""#B8C4D4""
           BorderThickness=""0"" FontFamily=""Consolas"" FontSize=""11.5"" Padding=""18,14""/>
</Grid>";
    }
}
