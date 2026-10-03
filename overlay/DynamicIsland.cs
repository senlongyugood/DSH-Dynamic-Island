// DynamicIsland.cs - desktop-level "Dynamic Island" status overlay for DeepSeek Harness.
//
// A frameless, transparent, always-on-top, non-activating window pinned to the top
// center of the primary screen. It polls the DSH host plugin's local snapshot
// endpoint, shows a compact pill while any task is running (or any approval /
// question is waiting), expands into a detail card on mouse-over, and lets a row
// click focus the Harness window and ask it to open that session.
//
// Build:  powershell -File build.ps1      (Roslyn csc -> DynamicIsland.exe, no XAML)
// Run:    DynamicIsland.exe [--url http://127.0.0.1:19391/island] [--probe] [--log <path>]

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;
using ShapePath = System.Windows.Shapes.Path;
using IoPath = System.IO.Path;

namespace DshDynamicIsland
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var options = Options.Parse(args);
            if (options == null) return 2;
            if (options.Help)
            {
                Console.WriteLine(Options.Usage);
                return 0;
            }

            var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
            var window = new IslandWindow(options);
            app.Run(window);
            return 0;
        }
    }

    internal sealed class Options
    {
        public string Url = "http://127.0.0.1:19391/island";
        public string FocusUrl = "http://127.0.0.1:19391/focus";
        public string LogPath = IoPath.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DynamicIsland",
            "island.log");
        public string ReportPath;
        public string DiscoveryPath = IoPath.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".dsh",
            "dynamic-island.json");
        public string HarnessProcess = "DeepSeek Harness";
        public int PollMs = 900;
        public int FirstPort = 19391;
        public double Scale = 0;
        /// <summary>Minutes a resting (idle) island stays on screen; 0 keeps it until DSH goes away.</summary>
        public double IdleHideMinutes = 0;
        public string SettingsPath;
        /** Keep a resting pill on screen even when there is nothing to report. */
        public bool AlwaysShow;
        /** Hide the island after its DSH data source stays unavailable. */
        public bool HideOnDisconnect;
        /** How long the pointer must rest on a task row before its context meter opens. */
        public int HoverDelayMs = 1000;
        public bool Probe;
        public bool Help;

        public const string Usage =
            "DynamicIsland - desktop overlay for DeepSeek Harness\n" +
            "  --url <snapshot url>    default http://127.0.0.1:19391/island\n" +
            "  --focus-url <url>       default http://127.0.0.1:19391/focus\n" +
            "  --discovery <path>      endpoint discovery file written by the host plugin\n" +
            "                          (default %USERPROFILE%\\.dsh\\dynamic-island.json)\n" +
            "  --log <path>            status log (also written by --probe)\n" +
            "  --report <path>         overwrite a live status file on every poll\n" +
            "  --poll <ms>             poll interval, default 900\n" +
            "  --port <n>              first push-receiver port, default 19391 (tries 5)\n" +
            "  --scale <n>             island size multiplier, e.g. 1.25 (0.7-2.5); without it\n" +
            "                          the value from the settings file is used\n" +
            "  --idle-hide <minutes>   hide a resting island after this long without a running\n" +
            "                          task; 0 (default) keeps it while DSH is around\n" +
            "  --always-show           keep a small resting pill on screen even with no task at all\n" +
            "  --hide-on-disconnect    hide after the DSH data source is unavailable for 5 seconds\n" +
            "  --hover-delay <ms>      how long the pointer rests on a task before its context meter\n" +
            "                          opens, default 1000\n" +
            "  --settings <path>       settings file (default: island.settings.json next to the exe)\n" +
            "  --probe                 poll once, write the report, then exit\n" +
            "  --help                  this text\n";

        public static Options Parse(string[] args)
        {
            var options = new Options();
            for (var index = 0; index < args.Length; index++)
            {
                var arg = args[index];
                switch (arg)
                {
                    case "--help": case "-h": options.Help = true; break;
                    case "--probe": options.Probe = true; break;
                    case "--hide-on-disconnect": options.HideOnDisconnect = true; break;
                    case "--url": if (!Next(args, ref index, out options.Url)) return null; break;
                    case "--focus-url": if (!Next(args, ref index, out options.FocusUrl)) return null; break;
                    case "--discovery": if (!Next(args, ref index, out options.DiscoveryPath)) return null; break;
                    case "--log": if (!Next(args, ref index, out options.LogPath)) return null; break;
                    case "--report": if (!Next(args, ref index, out options.ReportPath)) return null; break;
                    case "--process": if (!Next(args, ref index, out options.HarnessProcess)) return null; break;
                    case "--always-show": options.AlwaysShow = true; break;
                    case "--hover-delay":
                        string hoverText;
                        if (!Next(args, ref index, out hoverText)) return null;
                        int hoverMs;
                        if (!int.TryParse(hoverText, NumberStyles.Integer, CultureInfo.InvariantCulture, out hoverMs) || hoverMs < 0) return null;
                        options.HoverDelayMs = hoverMs;
                        break;
                    case "--idle-hide":
                        string idleText;
                        if (!Next(args, ref index, out idleText)) return null;
                        double idleMinutes;
                        if (!double.TryParse(idleText, NumberStyles.Float, CultureInfo.InvariantCulture, out idleMinutes) || idleMinutes < 0) return null;
                        options.IdleHideMinutes = idleMinutes;
                        break;
                    case "--poll":
                        string poll;
                        if (!Next(args, ref index, out poll)) return null;
                        int parsed;
                        if (!int.TryParse(poll, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed) || parsed < 100) return null;
                        options.PollMs = parsed;
                        break;
                    case "--port":
                        string portText;
                        if (!Next(args, ref index, out portText)) return null;
                        int port;
                        if (!int.TryParse(portText, NumberStyles.Integer, CultureInfo.InvariantCulture, out port) || port < 1 || port > 65535) return null;
                        options.FirstPort = port;
                        break;
                    case "--scale":
                        string scaleText;
                        if (!Next(args, ref index, out scaleText)) return null;
                        double scale;
                        if (!double.TryParse(scaleText, NumberStyles.Float, CultureInfo.InvariantCulture, out scale)) return null;
                        options.Scale = scale;
                        break;
                    case "--settings": if (!Next(args, ref index, out options.SettingsPath)) return null; break;
                    default:
                        Console.Error.WriteLine("unknown argument: " + arg);
                        return null;
                }
            }
            return options;
        }

        private static bool Next(string[] args, ref int index, out string value)
        {
            value = null;
            if (index + 1 >= args.Length) return false;
            value = args[++index];
            return true;
        }
    }

    /// <summary>One row of the host snapshot.</summary>
    internal sealed class TaskRow
    {
        public string Id = "";
        public string Title = "";
        public string Cwd = "";
        public bool Running;
        public double StartedAt;
        public double UpdatedAt;
        public string PendingKind;
        public string PendingText;
        /** DSH's call id for a pending request, used to route an island answer. */
        public string PendingCallId = "";
        public string PendingTool;
        public int JobsRunning;
        public int Children;
        /** Whether the main view already shows this session. */
        public bool Main;
        public string Signature = "";

        // Context token usage (the shipped context meter's own figures).
        public bool HasUsage;
        public double UsedTokens;
        public double ContextWindow;
        public int UsagePercent;
        public double SystemTokens;
        public double ToolsTokens;
        public double MessageTokens;
    }

    internal sealed class Snapshot
    {
        public readonly List<TaskRow> Rows = new List<TaskRow>();
        public string Error;
        public bool Ok;
    }

    /// <summary>One parsed request handed to the route table.</summary>
    internal sealed class MiniRequest
    {
        public string Method = "GET";
        public string Path = "/";
        public string Body = "";
    }

    /// <summary>One response the route table produced.</summary>
    internal sealed class MiniResponse
    {
        public int Status = 200;
        public string ContentType = "application/json; charset=utf-8";
        public string Body = "";
    }

    ///
    /// The overlay needs to *receive* pushes from the Harness page. HttpListener would
    /// require a URL ACL reservation on Windows, so this speaks just enough HTTP for
    /// two calls per second instead: one request per connection, a Content-Length body,
    /// and Connection: close.
    /// </summary>
    internal sealed class MiniHttpServer : IDisposable
    {
        private const int MaxRequestBytes = 512 * 1024;

        private readonly TcpListener _listener;
        private readonly Func<MiniRequest, MiniResponse> _route;
        private readonly Action<string> _log;
        private volatile bool _stopped;

        public MiniHttpServer(int port, Func<MiniRequest, MiniResponse> route, Action<string> log)
        {
            _listener = new TcpListener(IPAddress.Loopback, port);
            _route = route;
            _log = log;
        }

        /// <summary>Bind and start accepting; false when the port is taken.</summary>
        public bool Start()
        {
            try
            {
                _listener.Start();
            }
            catch (Exception error)
            {
                _log($"port {((IPEndPoint)_listener.LocalEndpoint).Port} unavailable: {error.Message}");
                return false;
            }
            var thread = new Thread(AcceptLoop) { IsBackground = true, Name = "island-http" };
            thread.Start();
            return true;
        }

        public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

        private void AcceptLoop()
        {
            while (!_stopped)
            {
                TcpClient client;
                try
                {
                    client = _listener.AcceptTcpClient();
                }
                catch
                {
                    return;
                }
                ThreadPool.QueueUserWorkItem(_ => Handle(client));
            }
        }

        private void Handle(TcpClient client)
        {
            try
            {
                using (client)
                using (var stream = client.GetStream())
                {
                    client.ReceiveTimeout = 3000;
                    client.SendTimeout = 3000;
                    var request = ReadRequest(stream);
                    if (request == null) return;
                    var response = _route(request);
                    WriteResponse(stream, response);
                }
            }
            catch (Exception error)
            {
                _log($"request failed: {error.Message}");
            }
        }

        private static MiniRequest ReadRequest(NetworkStream stream)
        {
            var buffer = new MemoryStream();
            var chunk = new byte[4096];
            var headerEnd = -1;
            while (headerEnd < 0)
            {
                var read = stream.Read(chunk, 0, chunk.Length);
                if (read <= 0) return null;
                buffer.Write(chunk, 0, read);
                if (buffer.Length > MaxRequestBytes) return null;
                headerEnd = IndexOfHeaderEnd(buffer.GetBuffer(), (int)buffer.Length);
            }

            var raw = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
            var lines = raw.Substring(0, headerEnd).Split(new[] { "\r\n" }, StringSplitOptions.None);
            var requestLine = lines.Length > 0 ? lines[0].Split(' ') : new string[0];
            var request = new MiniRequest
            {
                Method = requestLine.Length > 0 ? requestLine[0].ToUpperInvariant() : "GET",
                Path = requestLine.Length > 1 ? requestLine[1] : "/"
            };
            var queryAt = request.Path.IndexOf('?');
            if (queryAt >= 0) request.Path = request.Path.Substring(0, queryAt);

            var contentLength = 0;
            foreach (var line in lines)
            {
                var separator = line.IndexOf(':');
                if (separator <= 0) continue;
                if (!line.Substring(0, separator).Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
                int.TryParse(line.Substring(separator + 1).Trim(), out contentLength);
            }

            var headerBytes = Encoding.UTF8.GetByteCount(raw.Substring(0, headerEnd)) + 4;
            var bodyBytes = new byte[Math.Max(0, contentLength)];
            var alreadyBuffered = (int)buffer.Length - headerBytes;
            var copied = Math.Max(0, Math.Min(alreadyBuffered, bodyBytes.Length));
            if (copied > 0) Buffer.BlockCopy(buffer.GetBuffer(), headerBytes, bodyBytes, 0, copied);
            var remaining = bodyBytes.Length - copied;
            var offset = copied;
            while (remaining > 0)
            {
                var read = stream.Read(bodyBytes, offset, remaining);
                if (read <= 0) break;
                offset += read;
                remaining -= read;
            }
            request.Body = bodyBytes.Length == 0 ? "" : Encoding.UTF8.GetString(bodyBytes, 0, offset);
            return request;
        }

        private static int IndexOfHeaderEnd(byte[] bytes, int length)
        {
            for (var index = 3; index < length; index++)
            {
                if (bytes[index - 3] == 13 && bytes[index - 2] == 10 && bytes[index - 1] == 13 && bytes[index] == 10) return index - 3;
            }
            return -1;
        }

        private static void WriteResponse(NetworkStream stream, MiniResponse response)
        {
            var body = Encoding.UTF8.GetBytes(response.Body ?? "");
            var head = new StringBuilder();
            head.Append("HTTP/1.1 ").Append(response.Status).Append(' ').Append(StatusText(response.Status)).Append("\r\n");
            head.Append("Content-Type: ").Append(response.ContentType).Append("\r\n");
            head.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            head.Append("Access-Control-Allow-Origin: *\r\n");
            head.Append("Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n");
            head.Append("Access-Control-Allow-Headers: content-type\r\n");
            head.Append("Cache-Control: no-store\r\n");
            head.Append("Connection: close\r\n\r\n");
            var headBytes = Encoding.ASCII.GetBytes(head.ToString());
            stream.Write(headBytes, 0, headBytes.Length);
            if (body.Length > 0) stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        private static string StatusText(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 204: return "No Content";
                case 400: return "Bad Request";
                case 404: return "Not Found";
                default: return "OK";
            }
        }

        public void Dispose()
        {
            _stopped = true;
            try
            {
                _listener.Stop();
            }
            catch
            {
                /* shutting down */
            }
        }
    }

    /// <summary>A WebClient whose requests cannot stall the UI thread for the default 100 seconds.</summary>
    internal sealed class ShortTimeoutWebClient : WebClient
    {
        private readonly int _timeoutMs;

        public ShortTimeoutWebClient(int timeoutMs)
        {
            _timeoutMs = timeoutMs;
            Encoding = Encoding.UTF8;
        }

        protected override WebRequest GetWebRequest(Uri address)
        {
            var request = base.GetWebRequest(address);
            if (request != null)
            {
                request.Timeout = _timeoutMs;
                var http = request as HttpWebRequest;
                if (http != null) http.ReadWriteTimeout = _timeoutMs;
            }
            return request;
        }
    }

    internal sealed class IslandWindow : Window
    {
        // ---- palette (matches the in-app island) ----
        private static readonly Brush PillBrush = FromHex("#F20C0C0E");
        private static readonly Brush TitleBrush = FromHex("#F2F3F5");
        private static readonly Brush MutedBrush = FromHex("#8A8F98");
        private static readonly Brush SubBrush = FromHex("#99A0AA");
        private static readonly Brush DividerBrush = FromHex("#1AFFFFFF");
        private static readonly Brush ChipBrush = FromHex("#24FFFFFF");
        private static readonly Brush BadgeBgBrush = FromHex("#2EFF9F0A");
        private static readonly Brush BadgeFgBrush = FromHex("#FFB340");
        private static readonly Brush RowHoverBrush = FromHex("#14FFFFFF");
        private static readonly Brush RequestBgBrush = FromHex("#1AFF9F0A");
        private static readonly Brush RequestBorderBrush = FromHex("#3DFF9F0A");
        private static readonly Brush DotRunningBrush = FromHex("#4D8BFF");
        private static readonly Brush DotWarningBrush = FromHex("#FF9F0A");
        private static readonly Brush DotDoneBrush = FromHex("#32D74B");
        private static readonly Brush SystemSegmentBrush = FromHex("#8E9AAF");
        private static readonly Brush ToolsSegmentBrush = FromHex("#A78BFA");
        private static readonly Brush MessageSegmentBrush = FromHex("#4D8BFF");
        /** Remove-button colours (#F87171 at 15% and full). */
        private static readonly Brush DismissHoverBrush = FromHex("#26F87171");
        private static readonly Brush DismissStrokeBrush = FromHex("#F87171");

        private const double HeaderHeight = 24;
        private const double ExpandedWidth = 404;
        private const double MinCollapsedWidth = 132;
        /** With nothing to report the island is just this plain black block. */
        private const double EmptyWidth = 108;
        private const double EmptyHeight = 30;
        private const double MaxCollapsedWidth = 430;
        private const double MaxCardHeight = 440;
        private const double RootBorderThickness = 1;
        /** Expand feels deliberate, collapse feels snappy. */
        private const double MorphMs = 280;
        private const double CollapseMs = 200;
        private const double CollapseDelayMs = 200;

        private static readonly Thickness CollapsedPad = new Thickness(12, 5, 12, 5);
        private static readonly Thickness ExpandedPad = new Thickness(10, 8, 10, 10);
        // The root border takes one layout unit on each side of its padded content.
        private static readonly double ExpandedContentWidth = ExpandedWidth - ExpandedPad.Left - ExpandedPad.Right - 2 * RootBorderThickness;

        private readonly Options _options;
        private readonly ShortTimeoutWebClient _client;
        /** Posts Allow / Deny clicks back to the host half's /approval route. */
        private readonly DispatcherTimer _pollTimer = new DispatcherTimer();
        private readonly DispatcherTimer _collapseTimer = new DispatcherTimer();
        private readonly DispatcherTimer _meterTimer = new DispatcherTimer();
        private readonly DispatcherTimer _topmostTimer = new DispatcherTimer();
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        private readonly object _logLock = new object();

        private Border _root;
        private StackPanel _content;
        private Grid _header;
        private StackPanel _headerItems;
        private Ellipse _dot;
        private Ellipse _dotRing;
        private TextBlock _title;
        private Border _badge;
        private TextBlock _badgeText;
        private Border _count;
        private TextBlock _countText;
        private ShapePath _chevron;
        private Border _divider;
        private TextBlock _section;
        private StackPanel _rows;
                /** One task row's own context meter: the panel plus the pieces RebuildUsageBar needs. */
        private sealed class UsagePanel
        {
            public Border Root;
            public TextBlock Percent;
            public Border Track;
            public StackPanel Segments;
            public TextBlock Figures;
            public StackPanel Legend;
            public TaskRow Row;
            /** The row container (row + meter); its live IsMouseOver decides the reveal. */
            public StackPanel Container;
        }

        /** One task row's pending request: a read-only card saying what is being asked. */
        private sealed class RequestPanel
        {
            public Border Root;
            public TextBlock Head;
            public TextBlock Body;
            public TaskRow Row;
        }

        /** `sessionId|callId` for a pending request: what the answer route is keyed by. */
        /**
         * Requests the answer route refused because it never saw them — an approval asked before
         * this plugin's bridge loaded is answered by the shipped UI's own answerer, and no outside
         * party can claim it. The card then says so instead of offering a button that does nothing.
         */

        /** Swap a card's buttons for the explanation. */
        /** Request cards in display order, so the snapshot report can describe them. */
        private readonly List<RequestPanel> _requestPanels = new List<RequestPanel>();

        /** Row containers in display order, so hover can reveal the right meter. */
        private readonly List<UsagePanel> _rowPanels = new List<UsagePanel>();
        /** True while there is nothing to report, so the pill is just a black block. */
        private bool _empty;
        /** Session id whose row the pointer is over, so its meter stays open. */
        private string _hoverRow;
        /** Row whose context meter is actually on screen (set after the hover delay). */
        private string _meterRow;
        /** Row waiting out the hover delay before its meter opens. */
        private string _pendingMeterRow;
        private TextBlock _footer;
        private TextBlock _scaleHint;
        private double _scale = 1;
        /** Freed pixels around the pill inside the fixed window. */
        /**
         * Transparent margin kept around the card inside the window, in layout units.
         *
         * The card is the largest thing the window ever holds, so this is pure breathing room —
         * and it has to be comfortably wider than the 1px border and the rounded corner, because
         * at 150% scaling a hairline drawn exactly on the window edge gets shaved off. That is what
         * made the island look like a piece was missing from its right side (the chevron and the
         * request box's border).
         */
        private const double WindowSlack = 16;
        private Grid _host;
        private StackPanel _detail;

        private List<TaskRow> _model = new List<TaskRow>();
        /** Last tasks that were actually actionable, kept for the resting pill. */
        private List<TaskRow> _lastModel;
        /**
         * Tasks removed with the row's × button, with the state they were dismissed in. A
         * dismissal lasts until the task does something new (starts running, or raises a
         * different interaction), so a silenced task cannot reappear on every push.
         */
        private readonly Dictionary<string, DismissedState> _dismissed = new Dictionary<string, DismissedState>();

        private sealed class DismissedState
        {
            public bool Running;
            public string Pending = "";
            /** Activity stamp at dismissal time; a newer one means something happened. */
            public double UpdatedAt;
        }
        /** True while the island rests on those tasks because nothing is running. */
        private bool _idle;
        private DateTime? _idleSince;
        private string _modelSignature = "";
        private bool _expanded;
        private bool _animating;
        private bool _hasApplied;
        private double _windowWidth;
        private double _windowHeight;
        private int _frameCount;
        private DateTime _morphStartedAt = DateTime.MinValue;
        private double _morphDurationMs;
        private DateTime _lastFrameAt = DateTime.MinValue;
        private double _maxFrameGapMs;
        private RotateTransform _chevronRotate;
        private double _appliedWidth = -1;
        private double _appliedHeight = -1;
        private Thickness _appliedPad;
        private bool _appliedExpanded;
        /** How many morphs actually started; a steady state must not increase it. */
        private int _morphRuns;
        /** Why the last morph started, for the status report. */
        private string _lastMorphReason = "(none)";
        private double _collapsedWidth = MinCollapsedWidth;
        private double _expandedHeight = 120;
        /** Measured header height and the collapsed pill height that follows from it. */
        private double _headerHeight = HeaderHeight;
        private double _collapsedHeight = HeaderHeight + 10;
        private DateTime _lastPoll = DateTime.MinValue;
        private string _lastError;
        private int _pollCount;
        private bool _downloadInFlight;
        private bool _pulseOn;
        private string _hostUrl;
        private string _focusUrl;
        private DateTime _lastSuccess = DateTime.MinValue;
        private DateTime? _sourceDisconnectedAt;
        private readonly DateTime _processStartedAt = DateTime.UtcNow;
        private DateTime _lastDiscoveryRead = DateTime.MinValue;
        private MiniHttpServer _server;
        private string _pushedJson;
        private DateTime _pushedAt = DateTime.MinValue;
        private string _pendingFocus;
        /** Guards the focus queue: the UI thread queues, HTTP threads drain. */
        private readonly object _focusLock = new object();
        /// <summary>A push older than this is treated as gone, and the host endpoint is tried instead.</summary>
        private static readonly TimeSpan PushTtl = TimeSpan.FromSeconds(5);
        private static readonly TimeSpan DisconnectHideDelay = TimeSpan.FromSeconds(5);

        public IslandWindow(Options options)
        {
            _options = options;
            _client = new ShortTimeoutWebClient(900);
            _scale = options.Scale > 0 ? ClampScale(options.Scale) : LoadScale(options);
            ResolveEndpoint(true);
            BuildWindow();
            BuildContent();

            SourceInitialized += (s, e) => ApplyNativeStyles();
            Loaded += (s, e) =>
            {
                ApplyNativeStyles();
                ApplyScale();
                CentreHorizontally();
                StartPolling();
            };
        }

        // ------------------------------------------------------------------ window

        private void BuildWindow()
        {
            Title = "DSH Dynamic Island";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            // A null background paints nothing, so WPF does not hit-test the empty margin and
            // Windows routes clicks in transparent pixels to whatever is underneath.
            Background = null;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            ResizeMode = ResizeMode.NoResize;
            // Manual sizing: the window is fixed at the island's largest footprint, which keeps
            // the morph free of Win32 window resizes.
            SizeToContent = SizeToContent.Manual;
            Width = ExpandedWidth + WindowSlack;
            Height = HeaderHeight + CollapsedPad.Top + CollapsedPad.Bottom + WindowSlack;
            SnapsToDevicePixels = true;
            UseLayoutRounding = true;
            // Ideal formatting keeps whole glyphs: Display grid-fitting (crisper for Latin) drops the
            // lower strokes of CJK fallback glyphs at this window's fractional device size.
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Ideal);
            // Invisible until the first snapshot decides whether there is anything to show.
            Opacity = 0;
            Visibility = Visibility.Hidden;
        }

        private void BuildContent()
        {
            _dot = new Ellipse { Width = 8, Height = 8, Fill = DotRunningBrush, VerticalAlignment = VerticalAlignment.Center };
            _dotRing = new Ellipse
            {
                Width = 14, Height = 14, Stroke = DotRunningBrush, StrokeThickness = 2,
                Opacity = 0, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(-14, 0, 0, 0),
                HorizontalAlignment = HorizontalAlignment.Left, IsHitTestVisible = false
            };
            Pulse(_dotRing);

            _title = new TextBlock
            {
                Foreground = TitleBrush, FontSize = 12.5, FontWeight = FontWeights.Medium,
                VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis,
                MaxWidth = 236
                // No explicit LineHeight: it was a guess while chasing the missing glyph bottoms,
                // and it pushed the text's optical centre below the pill's. The natural line box,
                // centred by VerticalAlignment, is what sits evenly between the pill's edges.
            };            // The window formats text in Display mode (grid-fitted, crisp for Latin UI text). CJK
            // goes through a fallback font, and at a fractional device size that combination dropped
            // the lower strokes of every character — the "bottom half of the text is missing" report.
            // Ideal formatting keeps the whole glyph.
            TextOptions.SetTextFormattingMode(_title, TextFormattingMode.Ideal);
            TextOptions.SetTextRenderingMode(_title, TextRenderingMode.ClearType);

            _badgeText = new TextBlock { Foreground = BadgeFgBrush, FontSize = 10, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
            _badge = new Border
            {
                Background = BadgeBgBrush, CornerRadius = new CornerRadius(9), Height = 18,
                Padding = new Thickness(7, 0, 7, 0), Margin = new Thickness(2, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center, Visibility = Visibility.Collapsed,
                Child = _badgeText
            };

            _countText = new TextBlock { Foreground = TitleBrush, FontSize = 10, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
            _count = new Border
            {
                Background = ChipBrush, CornerRadius = new CornerRadius(8), Height = 16, MinWidth = 16,
                Padding = new Thickness(5, 0, 5, 0), Margin = new Thickness(2, 0, 0, 0),
                VerticalAlignment = VerticalAlignment.Center, Visibility = Visibility.Collapsed,
                Child = _countText
            };

            _chevronRotate = new RotateTransform(0);
            _chevron = new ShapePath
            {
                // Keep both rounded stroke caps inside the 12x12 drawing area.
                Data = Geometry.Parse("M2 4.5 L6 8.5 L10 4.5"),
                Stroke = FromHex("#73F2F3F5"), StrokeThickness = 1.6,
                StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round,
                Width = 12, Height = 12, Stretch = Stretch.None,
                VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(2, 0, 0, 0),
                RenderTransformOrigin = new Point(0.5, 0.5),
                RenderTransform = _chevronRotate
            };

            var dotHost = new Grid { Width = 14, Height = 14, VerticalAlignment = VerticalAlignment.Center };
            dotHost.Children.Add(_dotRing);
            dotHost.Children.Add(_dot);

            _headerItems = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
            _headerItems.Children.Add(dotHost);
            _headerItems.Children.Add(new Border { Width = 8 });
            _headerItems.Children.Add(_title);
            _headerItems.Children.Add(_badge);
            _headerItems.Children.Add(_count);
            _headerItems.Children.Add(_chevron);

            // The header measures its own height: a fixed one clipped the bottom of the title when
            // the badge or the running-count chip (or a taller CJK font) needed more room.
            _header = new Grid { MinHeight = HeaderHeight, VerticalAlignment = VerticalAlignment.Top };
            _header.Children.Add(_headerItems);

            _divider = new Border { Height = 1, Background = DividerBrush, Margin = new Thickness(2, 6, 2, 2) };
            _section = new TextBlock
            {
                Foreground = FromHex("#73F2F3F5"), FontSize = 10, FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(4, 6, 4, 4)
            };
            _rows = new StackPanel { Orientation = Orientation.Vertical };

            // The pending request lives with its own task row now (see RebuildRows): it shows under
            // that task, with Allow / Deny buttons the island itself can send.


            // The context meter lives with each task row now (see RebuildRows): hovering a row
            // opens that task's own meter between it and the row below.

            _footer = new TextBlock { Foreground = FromHex("#59F2F3F5"), FontSize = 10, Margin = new Thickness(4, 8, 4, 0), VerticalAlignment = VerticalAlignment.Center };
            _scaleHint = new TextBlock { Foreground = FromHex("#73F2F3F5"), FontSize = 10, Margin = new Thickness(4, 8, 4, 0), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            var footerRow = new Grid();
            footerRow.Children.Add(_footer);
            footerRow.Children.Add(_scaleHint);

            _detail = new StackPanel { Orientation = Orientation.Vertical, Width = ExpandedContentWidth };
            _detail.Children.Add(_divider);
            _detail.Children.Add(_section);
            _detail.Children.Add(_rows);
            _detail.Children.Add(footerRow);

            _content = new StackPanel { Orientation = Orientation.Vertical };
            _content.Children.Add(_header);
            _content.Children.Add(_detail);

            _root = new Border
            {
                Background = PillBrush,
                BorderBrush = FromHex("#24FFFFFF"),
                BorderThickness = new Thickness(RootBorderThickness),
                CornerRadius = new CornerRadius(17),
                Padding = CollapsedPad,
                ClipToBounds = true,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Top,
                Width = MinCollapsedWidth,
                Height = HeaderHeight + CollapsedPad.Top + CollapsedPad.Bottom,
                // No DropShadowEffect: the window is only as large as the pill, so a blurred
                // shadow gets clipped into a flat grey plate whose square corners read as
                // "grey squares" behind the rounded pill. The 1px light border gives the
                // shape its definition instead.
                Child = _content
            };

            // The window stays at the largest size the island ever needs, and only the pill
            // inside it morphs. Resizing the window (which also re-centres it) on every frame
            // is what made the old animation stutter; a Windows layered window passes the
            // mouse through fully transparent pixels, so the empty margin costs nothing and
            // blocks nothing.
            _host = new Grid { Background = null };
            _host.Children.Add(_root);

            Content = _host;
            MouseEnter += (s, e) => Expand();
            MouseLeave += (s, e) => ScheduleCollapse();
            MouseWheel += OnMouseWheel;
            Closed += (s, e) =>
            {
                CompositionTarget.Rendering -= OnRendering;
                if (_server != null) _server.Dispose();
                SaveScale();
            };
        }

        // ------------------------------------------------------------------ size

        /// <summary>Smallest and largest island scale the wheel may reach.</summary>
        private const double MinScale = 0.7;
        private const double MaxScale = 2.5;

        private static double ClampScale(double value)
        {
            return Math.Min(MaxScale, Math.Max(MinScale, Math.Round(value * 20) / 20));
        }

        /// <summary>Directory holding the executable, for the default settings file.</summary>
        private static string ExecutableDirectory()
        {
            try
            {
                var module = Process.GetCurrentProcess().MainModule;
                if (module != null && !string.IsNullOrEmpty(module.FileName))
                {
                    var dir = IoPath.GetDirectoryName(module.FileName);
                    if (!string.IsNullOrEmpty(dir)) return dir;
                }
            }
            catch
            {
                /* fall through to the working directory */
            }
            return Environment.CurrentDirectory;
        }

        /// <summary>Settings file: `{ "scale": 1.25 }` beside the exe unless overridden.</summary>
        private static string ResolveSettingsPath(Options options)
        {
            return !string.IsNullOrEmpty(options.SettingsPath)
                ? options.SettingsPath
                : IoPath.Combine(ExecutableDirectory(), "island.settings.json");
        }

        /// <summary>Read the persisted scale; 1 when absent or unreadable.</summary>
        private static double LoadScale(Options options)
        {
            try
            {
                var path = ResolveSettingsPath(options);
                if (!File.Exists(path)) return 1;
                var map = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
                object raw;
                if (map != null && map.TryGetValue("scale", out raw) && raw != null)
                {
                    var value = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                    if (value > 0) return ClampScale(value);
                }
            }
            catch
            {
                /* a broken settings file must not stop the island */
            }
            return 1;
        }

        /// <summary>Persist the current scale so the next start keeps it.</summary>
        private void SaveScale()
        {
            try
            {
                File.WriteAllText(ResolveSettingsPath(_options), "{\n  \"scale\": " + _scale.ToString("0.##", CultureInfo.InvariantCulture) + "\n}\n", Encoding.UTF8);
            }
            catch (Exception error)
            {
                Log("saving the settings file failed: " + error.Message);
            }
        }

        /// <summary>
        /// Ctrl + wheel resizes the island. The scale rides on the content's LayoutTransform,
        /// so every measurement (pill width, card height) scales with it; the fixed window
        /// footprint is recomputed to match.
        /// </summary>
        private void OnMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if ((Keyboard.Modifiers & ModifierKeys.Control) != ModifierKeys.Control) return;
            e.Handled = true;
            var next = ClampScale(_scale + (e.Delta > 0 ? 0.05 : -0.05));
            if (Math.Abs(next - _scale) < 0.001) return;
            _scale = next;
            ApplyScale();
            SaveScale();
            Log("scale set to " + _scale.ToString("0.##", CultureInfo.InvariantCulture));
        }

        /// <summary>Push the current scale into the content transform and re-measure.</summary>
        private void ApplyScale()
        {
            var transform = _root.LayoutTransform as ScaleTransform;
            if (transform == null)
            {
                transform = new ScaleTransform(_scale, _scale);
                _root.LayoutTransform = transform;
            }
            else
            {
                transform.ScaleX = _scale;
                transform.ScaleY = _scale;
            }
            _scaleHint.Text = "缩放 " + Math.Round(_scale * 100).ToString(CultureInfo.InvariantCulture) + "%";
            MeasureSizes();
            ApplyState(false);
        }

        // ------------------------------------------------------------------ native

        private void ApplyNativeStyles()
        {
            var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            if (handle == IntPtr.Zero) return;
            var style = GetWindowLong(handle, GWL_EXSTYLE);
            style |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            SetWindowLong(handle, GWL_EXSTYLE, style);
        }

        private void CentreHorizontally()
        {
            // The window keeps its full footprint while the pill morphs inside it, so this
            // runs only when that footprint (or the scale) changes - never per frame.
            var width = _windowWidth > 0 ? _windowWidth : (ActualWidth > 0 ? ActualWidth : _root.Width);
            var screenWidth = SystemParameters.PrimaryScreenWidth;
            Left = Math.Max(0, (screenWidth - width) / 2.0);
            Top = 6;
        }

        // ------------------------------------------------------------------ polling

        private void StartPolling()
        {
            StartServer();

            _client.DownloadStringCompleted += (s, e) => OnSnapshot(e);

            _pollTimer.Interval = TimeSpan.FromMilliseconds(_options.PollMs);
            _pollTimer.Tick += (s, e) => Poll();
            _pollTimer.Start();

            // A row's context meter opens only after the pointer has rested on it for a moment, so
            // running the mouse across the list does not flash meters open and shut.
            _meterTimer.Interval = TimeSpan.FromMilliseconds(Math.Max(0, _options.HoverDelayMs));
            _meterTimer.Tick += (s, e) =>
            {
                _meterTimer.Stop();
                if (_pendingMeterRow == null || _hoverRow != _pendingMeterRow) return;
                _meterRow = _pendingMeterRow;
                if (_expanded) ApplyRowHover();
            };

            _collapseTimer.Interval = TimeSpan.FromMilliseconds(CollapseDelayMs);
            _collapseTimer.Tick += (s, e) =>
            {
                _collapseTimer.Stop();
                // The morph moves the pill under a stationary pointer, so WPF can report a
                // leave that is not a real exit; require the pointer to be outside the pill.
                var inside = PointerInsidePill();
                if (!IsMouseOver && !inside)
                {
                    Log($"collapse (pointer gone: {PointerState()})");
                    Collapse();
                }
                else if (!IsMouseOver)
                {
                    Log($"collapse skipped: pointer still inside the window ({PointerState()})");
                }
            };

            _topmostTimer.Interval = TimeSpan.FromSeconds(5);
            _topmostTimer.Tick += (s, e) => { if (!Topmost) Topmost = true; };
            _topmostTimer.Start();

            Poll();
        }

        /// <summary>
        /// Pick the snapshot endpoint: the host plugin's discovery file when it is
        /// present and sane, otherwise the configured URL.
        /// </summary>
        private void ResolveEndpoint(bool force)
        {
            var now = DateTime.UtcNow;
            if (!force && (now - _lastDiscoveryRead).TotalSeconds < 5) return;
            _lastDiscoveryRead = now;

            var resolved = false;
            try
            {
                if (File.Exists(_options.DiscoveryPath))
                {
                    var map = _json.DeserializeObject(File.ReadAllText(_options.DiscoveryPath, Encoding.UTF8)) as Dictionary<string, object>;
                    object rawPort;
                    if (map != null && map.TryGetValue("port", out rawPort) && rawPort != null)
                    {
                        var port = Convert.ToInt32(rawPort, CultureInfo.InvariantCulture);
                        if (port > 0 && port < 65536)
                        {
                            _hostUrl = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/island";
                            _focusUrl = "http://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture) + "/focus";
                            resolved = true;
                        }
                    }
                }
            }
            catch (Exception error)
            {
                Log("discovery read failed: " + error.Message);
            }

            if (resolved) return;
            _hostUrl = _options.Url;
            _focusUrl = _options.FocusUrl;
        }

        /// <summary>
        /// Bind the push receiver on the first free overlay port. The Harness page probes
        /// the same range and pushes its task view here about once a second.
        /// </summary>
        private void StartServer()
        {
            for (var offset = 0; offset < 5; offset += 1)
            {
                var server = new MiniHttpServer(_options.FirstPort + offset, Route, Log);
                if (!server.Start()) continue;
                _server = server;
                Log($"push receiver listening on http://127.0.0.1:{server.Port}");

                // A discovery file naming our own port would make the fallback poll
                // ourselves; that is not a second source, so drop it.
                if (_hostUrl != null && _hostUrl.Contains($":{server.Port}/"))
                {
                    _hostUrl = null;
                    Log($"host endpoint resolves to this overlay (port {server.Port}); page pushes are the only source");
                }
                return;
            }
            Log("push receiver could not bind any port; falling back to the host endpoint only");
        }

        /// <summary>Route table for the push receiver and the browser's focus queue.</summary>
        private MiniResponse Route(MiniRequest request)
        {
            if (request.Method == "OPTIONS") return new MiniResponse { Status = 204, Body = "" };

            if (request.Path == "/health")
            {
                return new MiniResponse { Status = 200, ContentType = "text/plain; charset=utf-8", Body = "dynamic-island-overlay" };
            }

            if (request.Path == "/island")
            {
                if (request.Method == "POST")
                {
                    _pushedJson = request.Body;
                    _pushedAt = DateTime.UtcNow;
                    return new MiniResponse { Status = 200, Body = "{\"ok\":true}" };
                }
                return new MiniResponse { Status = 200, Body = _pushedJson ?? "{\"version\":1,\"tasks\":[]}" };
            }

            if (request.Path == "/focus")
            {
                if (request.Method == "POST")
                {
                    var sessionId = SessionIdOf(request.Body);
                    if (!string.IsNullOrEmpty(sessionId)) { lock (_focusLock) _pendingFocus = sessionId; }
                    return new MiniResponse { Status = 200, Body = "{\"ok\":true}" };
                }
                string taken;
                lock (_focusLock)
                {
                    taken = _pendingFocus;
                    _pendingFocus = null;
                }
                return new MiniResponse
                {
                    Status = 200,
                    Body = taken == null ? "{\"sessionId\":null}" : "{\"sessionId\":" + Quote(taken) + "}"
                };
            }

            return new MiniResponse { Status = 404, Body = "{\"error\":\"not found\"}" };
        }

        /// <summary>Pull the session id out of a `{ "sessionId": "..." }` body.</summary>
        private string SessionIdOf(string body)
        {
            if (string.IsNullOrEmpty(body)) return null;
            try
            {
                var map = _json.DeserializeObject(body) as Dictionary<string, object>;
                var value = map == null || !map.ContainsKey("sessionId") ? null : map["sessionId"] as string;
                return string.IsNullOrEmpty(value) ? null : value;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>JSON-quote a string for the small hand-built responses above.</summary>
        private static string Quote(string value)
        {
            return _jsonStatic.Serialize(value);
        }

        private static readonly JavaScriptSerializer _jsonStatic = new JavaScriptSerializer();

        /// <summary>
        /// Whether the pointer is inside the visible pill, not merely the window rectangle.
        ///
        /// The window is deliberately larger than the pill (so morphing never resizes it) and
        /// its empty margin is transparent, so the OS never sends us mouse input from there -
        /// which is exactly why the collapse decision must use the pill's own bounds.
        /// </summary>
        private bool PointerInsidePill()
        {
            try
            {
                if (!IsVisible) return false;
                WINPOINT point;
                if (!GetCursorPos(out point)) return false;
                var local = PointFromScreen(new Point(point.X, point.Y));
                var pill = PillBounds();
                return local.X >= pill.Left && local.X <= pill.Right && local.Y >= pill.Top && local.Y <= pill.Bottom;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// The pill's current layout slot in window coordinates, grown by a few pixels so a
        /// pointer on the antialiased edge still counts as inside.
        /// </summary>
        private Rect PillBounds()
        {
            var width = _root.ActualWidth > 0 ? _root.ActualWidth : _root.Width;
            var height = _root.ActualHeight > 0 ? _root.ActualHeight : _root.Height;
            var left = Math.Max(0, (Width - width) / 2);
            return new Rect(left - 4, -4, width + 8, height + 8);
        }

        /// <summary>Kick off one non-blocking snapshot download; a slow host never stalls the island.</summary>
        private void Poll()
        {
            // A live page push wins: it carries what the page actually renders and needs
            // no host-side plugin activation.
            if (_pushedJson != null && DateTime.UtcNow - _pushedAt <= PushTtl)
            {
                var pushed = Parse(_pushedJson);
                if (pushed.Ok)
                {
                    _lastSuccess = _pushedAt;
                    _sourceDisconnectedAt = null;
                }
                ApplySnapshot(pushed, true);
                return;
            }

            // No page and no host endpoint means DSH itself is not around: hide rather than
            // leaving a stale pill on screen.
            if (_hostUrl == null)
            {
                if (_options.HideOnDisconnect)
                {
                    if (ShouldHideDisconnectedSource()) HideForDisconnectedSource();
                    else if (_options.AlwaysShow && _model.Count == 0) KeepVisibleOrHide();
                    return;
                }
                ApplySnapshot(new Snapshot { Ok = true }, false);
                return;
            }

            if (_downloadInFlight) return;
            _downloadInFlight = true;
            try
            {
                _client.DownloadStringAsync(new Uri(_hostUrl));
            }
            catch (Exception error)
            {
                _downloadInFlight = false;
                OnSnapshotText(null, error.Message);
            }
        }

        private void OnSnapshot(DownloadStringCompletedEventArgs args)
        {
            _downloadInFlight = false;
            if (args.Error != null)
            {
                OnSnapshotText(null, args.Error.Message);
                return;
            }
            OnSnapshotText(args.Result, null);
        }

        private void OnSnapshotText(string text, string error)
        {
            if (error != null)
            {
            // A short host blip must not blank the island; --hide-on-disconnect retires the
            // visible state only after the configured reconnect grace period.
                _lastError = error;
                if ((DateTime.UtcNow - _lastSuccess).TotalSeconds > 5) ResolveEndpoint(false);
                var hiddenForDisconnect = _options.HideOnDisconnect && ShouldHideDisconnectedSource();
                if (hiddenForDisconnect) HideForDisconnectedSource();
                if (_options.ReportPath != null) WriteReport(new Snapshot { Ok = false, Error = error });
                if (hiddenForDisconnect) return;
                // WPF's IsVisible is not trustworthy here (it can report true while the Win32 window
                // has no WS_VISIBLE), so the decision uses what the island has to show instead.
                if (_options.AlwaysShow && _model.Count == 0) KeepVisibleOrHide();
                return;
            }

            var snapshot = Parse(text);
            if (snapshot.Ok)
            {
                _lastSuccess = DateTime.UtcNow;
                _sourceDisconnectedAt = null;
            }
            ApplySnapshot(snapshot, true);
        }

        /// <summary>Whether DSH has remained unavailable beyond the reconnect grace period.</summary>
        private bool ShouldHideDisconnectedSource()
        {
            if (!_options.HideOnDisconnect) return false;
            if (_sourceDisconnectedAt == null)
            {
                _sourceDisconnectedAt = _lastSuccess == DateTime.MinValue
                    ? _processStartedAt
                    : _lastSuccess;
            }
            return DateTime.UtcNow - _sourceDisconnectedAt.Value >= DisconnectHideDelay;
        }

        /// <summary>Clear stale task details and hide; polling stays active so a reopened DSH can restore the island.</summary>
        private void HideForDisconnectedSource()
        {
            if (_model.Count > 0 || _lastModel != null || Visibility == Visibility.Visible)
            {
                Log("DSH data source remained unavailable; hiding the island");
            }
            _model = new List<TaskRow>();
            _lastModel = null;
            _modelSignature = "";
            _rows.Children.Clear();
            _rowPanels.Clear();
            _requestPanels.Clear();
            _idle = false;
            _idleSince = null;
            _expanded = false;
            _hoverRow = null;
            _meterRow = null;
            _pendingMeterRow = null;
            _meterTimer.Stop();
            _collapseTimer.Stop();
            _empty = true;
            _header.Visibility = Visibility.Collapsed;
            _detail.Visibility = Visibility.Collapsed;
            MeasureSizes();
            ApplyState(false);
            SetWindowShown(false);
        }

        /// <summary>
        /// Show or hide the window, driving the Win32 state explicitly.
        ///
        /// WPF's Hide()/Show() bookkeeping can report Visibility=Visible while the
        /// Win32 window still lacks WS_VISIBLE (observed after a startup hide), which
        /// leaves an "invisible but on screen" island. ShowWindow makes the real state
        /// match the intent, without stealing focus.
        /// </summary>
        private void SetWindowShown(bool shown)
        {
            if (shown)
            {
                if (Visibility != Visibility.Visible) Show();
            }
            else if (Visibility != Visibility.Hidden)
            {
                Hide();
            }

            var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
            if (handle != IntPtr.Zero) ShowWindow(handle, shown ? SW_SHOWNOACTIVATE : SW_HIDE);
        }

        /// <summary>
        /// Render one snapshot.
        ///
        /// A live source with nothing actionable does not blank the island: the last known tasks
        /// are kept as a resting state ("空闲"), so the island does not vanish the moment a turn
        /// ends. Only a snapshot with no source behind it (no page and no host) hides it, and an
        /// optional retention window (`--idle-hide`) can hide a resting island after a while.
        /// </summary>
        private void ApplySnapshot(Snapshot snapshot, bool sourceAlive)
        {
            _pollCount++;
            _lastPoll = DateTime.Now;
            _lastError = snapshot.Error;
            if (_options.ReportPath != null) WriteReport(snapshot);

            if (_options.Probe)
            {
                if (snapshot.Ok && snapshot.Rows.Count > 0)
                {
                    _model = snapshot.Rows;
                    UpdateModel();
                }
                WriteReport(snapshot);
                _pollTimer.Stop();
                Close();
                return;
            }

            if (snapshot.Ok && snapshot.Rows.Count > 0)
            {
                var rows = FilterRows(snapshot.Rows);
                if (rows.Count > 0)
                {
                    _model = rows;
                    _lastModel = rows;
                    _idle = false;
                    _idleSince = null;
                    UpdateModel();
                    if (Opacity < 1) Opacity = 1;
                    SetWindowShown(true);
                    return;
                }
            }

            // Nothing actionable right now.
            var resting = sourceAlive && _lastModel != null && _lastModel.Count > 0;
            if (resting && _options.IdleHideMinutes > 0)
            {
                if (_idleSince == null) _idleSince = DateTime.UtcNow;
                if ((DateTime.UtcNow - _idleSince.Value).TotalMinutes >= _options.IdleHideMinutes) resting = false;
            }

            if (resting)
            {
                _model = RestingCopy(_lastModel);
                _idle = true;
                UpdateModel();
                if (Opacity < 1) Opacity = 1;
                SetWindowShown(true);
                return;
            }

            // Nothing to report. An always-on island keeps a small resting pill instead of hiding.
            KeepVisibleOrHide();
        }

        /// <summary>
        /// The island has nothing to show: hide it, or — with --always-show — keep a resting pill so
        /// the desktop island does not blink in and out of existence.
        /// </summary>
        private void KeepVisibleOrHide()
        {
            if (_options.AlwaysShow)
            {
                _model = _lastModel ?? new List<TaskRow>();
                _idle = true;
                UpdateModel();
                if (Opacity < 1) Opacity = 1;
                SetWindowShown(true);
                return;
            }

            _model = new List<TaskRow>();
            _modelSignature = "";
            _idleSince = null;
            SetWindowShown(false);
        }

        /// <summary>
        /// Drop tasks the user removed with the row's × button.
        ///
        /// A dismissal is released as soon as the task starts a new run or asks for a different
        /// interaction, so removing a task silences it without hiding genuinely new activity.
        /// </summary>
        private List<TaskRow> FilterRows(List<TaskRow> rows)
        {
            if (_dismissed.Count == 0) return rows;
            var kept = new List<TaskRow>(rows.Count);
            foreach (var row in rows)
            {
                DismissedState state;
                if (row.Id.Length == 0 || !_dismissed.TryGetValue(row.Id, out state))
                {
                    kept.Add(row);
                    continue;
                }

                var pending = row.PendingKind ?? "";
                var newActivity = row.UpdatedAt > state.UpdatedAt;
                var newRun = row.Running && !state.Running;
                var newInteraction = pending.Length > 0 && pending != state.Pending;
                if (newActivity || newRun || newInteraction)
                {
                    _dismissed.Remove(row.Id);
                    Log("dismissal released for " + row.Id + " ("
                        + (newActivity ? "new activity" : newRun ? "new run" : "new interaction") + ")");
                    kept.Add(row);
                    continue;
                }
                // Still the same task with nothing new: stay hidden.
                state.Running = row.Running;
                state.Pending = pending;
            }
            return kept;
        }

        /// <summary>Remove one task from the island for as long as its state does not change.</summary>
        private void Dismiss(TaskRow row)
        {
            if (row == null || row.Id.Length == 0) return;
            _dismissed[row.Id] = new DismissedState
            {
                Running = row.Running, Pending = row.PendingKind ?? "", UpdatedAt = row.UpdatedAt
            };
            Log("dismissed " + row.Id + " (" + row.Title + ")");

            var remaining = new List<TaskRow>();
            foreach (var candidate in _model) if (candidate.Id != row.Id) remaining.Add(candidate);
            _model = remaining;
            _lastModel = remaining.Count > 0 ? remaining : null;
            _modelSignature = "";
            if (remaining.Count == 0 && !_options.AlwaysShow)
            {
                SetWindowShown(false);
                return;
            }
            UpdateModel();
        }

        /// <summary>The last tasks with their live state cleared, for the resting pill.</summary>
        private static List<TaskRow> RestingCopy(List<TaskRow> source)
        {
            var copy = new List<TaskRow>(source.Count);
            foreach (var row in source)
            {
                copy.Add(new TaskRow
                {
                    Id = row.Id, Title = row.Title, Cwd = row.Cwd, UpdatedAt = row.UpdatedAt,
                    Main = row.Main, Children = row.Children,
                    Running = false, PendingKind = null, PendingText = null, JobsRunning = 0,
                    Signature = row.Signature
                });
            }
            return copy;
        }

        private Snapshot Parse(string text)
        {
            var snapshot = new Snapshot { Ok = true };
            var root = _json.DeserializeObject(text) as Dictionary<string, object>;
            if (root == null) { snapshot.Ok = false; snapshot.Error = "malformed snapshot"; return snapshot; }

            object rawTasks;
            if (!root.TryGetValue("tasks", out rawTasks) || rawTasks == null) return snapshot;
            var tasks = rawTasks as object[];
            if (tasks == null) return snapshot;

            foreach (var item in tasks)
            {
                var map = item as Dictionary<string, object>;
                if (map == null) continue;
                var row = new TaskRow
                {
                    Id = Str(map, "id"),
                    Title = Str(map, "title"),
                    Cwd = Str(map, "cwd"),
                    Running = Bool(map, "running"),
                    Main = Bool(map, "main"),
                    StartedAt = Num(map, "startedAt"),
                    UpdatedAt = Num(map, "updatedAt"),
                    Children = (int)Num(map, "children")
                };
                object pending;
                if (map.TryGetValue("pending", out pending))
                {
                    var pendingMap = pending as Dictionary<string, object>;
                    if (pendingMap != null)
                    {
                        row.PendingKind = Str(pendingMap, "kind");
                        row.PendingText = Str(pendingMap, "text");
                row.PendingCallId = Str(pendingMap, "callId");
                        row.PendingTool = Str(pendingMap, "toolName");
                    }
                }
                object jobs;
                if (map.TryGetValue("jobs", out jobs))
                {
                    var jobsMap = jobs as Dictionary<string, object>;
                    if (jobsMap != null) row.JobsRunning = (int)Num(jobsMap, "running");
                }

                object usage;
                if (map.TryGetValue("usage", out usage))
                {
                    var usageMap = usage as Dictionary<string, object>;
                    if (usageMap != null && Num(usageMap, "contextWindow") > 0)
                    {
                        row.HasUsage = true;
                        row.UsedTokens = Num(usageMap, "usedTokens");
                        row.ContextWindow = Num(usageMap, "contextWindow");
                        row.UsagePercent = (int)Num(usageMap, "percent");
                        row.SystemTokens = Num(usageMap, "systemTokens");
                        row.ToolsTokens = Num(usageMap, "toolsTokens");
                        row.MessageTokens = Num(usageMap, "messageTokens");
                    }
                }

                row.Signature = string.Join("|", new[]
                {
                    // Usage figures deliberately excluded: they change every second, and the
                    // metric block is refreshed in place, so a rebuild per poll would only
                    // reset the row list and make the card twitch.
                    row.Id, row.Title, row.Cwd, row.Running ? "1" : "0", row.PendingKind ?? "", row.PendingText ?? "",
                    row.JobsRunning.ToString(CultureInfo.InvariantCulture), row.Children.ToString(CultureInfo.InvariantCulture),
                    row.Main ? "current" : ""
                });
                snapshot.Rows.Add(row);
            }
            return snapshot;
        }

        private static string Str(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return "";
            return value as string ?? Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static bool Bool(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return false;
            if (value is bool) return (bool)value;
            return string.Equals(Convert.ToString(value, CultureInfo.InvariantCulture), "true", StringComparison.OrdinalIgnoreCase);
        }

        private static double Num(Dictionary<string, object> map, string key)
        {
            object value;
            if (!map.TryGetValue(key, out value) || value == null) return 0;
            try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); }
            catch { return 0; }
        }

        // ------------------------------------------------------------------ model -> ui

        private void UpdateModel()
        {
            var signatureBuilder = new StringBuilder();
            foreach (var row in _model) signatureBuilder.Append(row.Signature).Append('\n');
            var signature = signatureBuilder.ToString();
            var structureChanged = signature != _modelSignature;
            _modelSignature = signature;

            var primary = Primary();
            string labelText;
            CompactLabel(out labelText);

            // Nothing at all: the island is a plain black block, so there is no header to draw and
            // nothing to hover open.
            _empty = _model.Count == 0;
            _header.Visibility = _empty ? Visibility.Collapsed : Visibility.Visible;
            _detail.Visibility = _empty ? Visibility.Collapsed : Visibility.Visible;
            if (_empty && _expanded)
            {
                _expanded = false;
                _hoverRow = null;
                _meterRow = null;
                _pendingMeterRow = null;
                _meterTimer.Stop();
            }

            _title.Text = _empty ? "" : labelText;
            _title.Foreground = primary != null && primary.Title.Length > 0 ? TitleBrush : MutedBrush;

            if (primary != null && primary.PendingKind != null)
            {
                _badge.Visibility = Visibility.Visible;
                _badgeText.Text = BadgeText(primary.PendingKind);
            }
            else
            {
                _badge.Visibility = Visibility.Collapsed;
            }

            var runningCount = 0;
            foreach (var row in _model) if (row.Running) runningCount++;
            if (runningCount > 1)
            {
                _count.Visibility = Visibility.Visible;
                _countText.Text = runningCount.ToString(CultureInfo.InvariantCulture);
            }
            else
            {
                _count.Visibility = Visibility.Collapsed;
            }

            var dotBrush = primary == null ? MutedBrush
                : primary.PendingKind != null ? DotWarningBrush
                : primary.Running ? DotRunningBrush : DotDoneBrush;
            _dot.Fill = dotBrush;
            _dotRing.Stroke = dotBrush;
            SetPulse(primary != null && (primary.PendingKind != null || primary.Running));

            _section.Text = string.Format(CultureInfo.InvariantCulture, "任务 {0}", _model.Count);

            _footer.Text = "点击任务可打开对应会话 · × 从岛上移除 · Ctrl+滚轮调整大小 · Esc 收起";

            if (structureChanged) RebuildRows();
            else ApplyRowHover();

            MeasureSizes();
            ApplyState(true);
        }

        /// <summary>
        /// One task's pending request card: what is being asked, and nothing else. The island only
        /// reports that an approval is waiting — answering stays in the shipped Harness UI.
        /// </summary>
        private RequestPanel BuildRequestPanel(TaskRow row)
        {
            var panel = new RequestPanel { Row = row };
            panel.Head = new TextBlock { Foreground = BadgeFgBrush, FontSize = 10, FontWeight = FontWeights.SemiBold };
            panel.Body = new TextBlock
            {
                Foreground = FromHex("#DBF2F3F5"), FontSize = 11.5, LineHeight = 17, TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 5, 0, 0), MaxHeight = 112
            };
            panel.Head.Text = row != null && row.PendingKind == "approval" ? "请求详情" : "等待回答";
            panel.Body.Text = row == null ? "" : Truncate(row.PendingText ?? "", 600);

            var inner = new StackPanel();
            inner.Children.Add(panel.Head);
            inner.Children.Add(panel.Body);

            panel.Root = new Border
            {
                Background = RequestBgBrush, BorderBrush = RequestBorderBrush, BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12), Padding = new Thickness(10, 8, 10, 8),
                // Keep the card inside the fixed detail width even if another row measures wider.
                Width = ExpandedContentWidth - 12, Margin = new Thickness(6, 2, 6, 6), Child = inner
            };
            return panel;
        }

        /// <summary>
        /// One task's context meter, mirroring the shipped in-app meter: used versus the model's
        /// window plus the system / tools / messages split. It starts collapsed and is revealed
        /// by hovering the row it belongs to.
        /// </summary>
        private UsagePanel BuildUsagePanel(TaskRow row)
        {
            var panel = new UsagePanel { Row = row };
            panel.Percent = new TextBlock
            {
                Foreground = TitleBrush, FontSize = 10, FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Right
            };
            var label = new TextBlock
            {
                Text = "上下文用量", Foreground = MutedBrush, FontSize = 10,
                FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center
            };
            var head = new Grid { Margin = new Thickness(4, 6, 4, 0) };
            head.Children.Add(label);
            head.Children.Add(panel.Percent);

            panel.Segments = new StackPanel { Orientation = Orientation.Horizontal };
            panel.Track = new Border
            {
                Background = FromHex("#1FFFFFFF"), CornerRadius = new CornerRadius(2), Height = 4,
                HorizontalAlignment = HorizontalAlignment.Stretch, Child = panel.Segments
            };
            panel.Track.SizeChanged += (s, e) => RebuildUsageBar(panel);
            var barHost = new Grid { Margin = new Thickness(4, 6, 4, 0), Height = 4 };
            barHost.Children.Add(panel.Track);

            panel.Figures = new TextBlock { Foreground = FromHex("#B3F2F3F5"), FontSize = 11, Margin = new Thickness(4, 6, 4, 0) };
            panel.Legend = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 4, 4, 0) };

            var stack = new StackPanel { Orientation = Orientation.Vertical };
            stack.Children.Add(head);
            stack.Children.Add(barHost);
            stack.Children.Add(panel.Figures);
            stack.Children.Add(panel.Legend);

            panel.Root = new Border
            {
                Background = FromHex("#12FFFFFF"), CornerRadius = new CornerRadius(12),
                Padding = new Thickness(10, 2, 10, 6), Margin = new Thickness(4, 2, 4, 4),
                Visibility = Visibility.Collapsed, Child = stack
            };

            if (row != null && row.HasUsage)
            {
                panel.Percent.Text = row.UsagePercent.ToString(CultureInfo.InvariantCulture) + "%";
                panel.Percent.Foreground = row.UsagePercent >= 85 ? DotWarningBrush : TitleBrush;
                panel.Figures.Text = string.Format(
                    CultureInfo.InvariantCulture,
                    "~{0} / {1}   ·   剩余 {2}",
                    FormatTokens(row.UsedTokens),
                    FormatTokens(row.ContextWindow),
                    FormatTokens(Math.Max(0, row.ContextWindow - row.UsedTokens)));
                AddLegend(panel, "系统", row.SystemTokens, SystemSegmentBrush);
                AddLegend(panel, "工具", row.ToolsTokens, ToolsSegmentBrush);
                AddLegend(panel, "消息", row.MessageTokens, MessageSegmentBrush);
            }
            return panel;
        }

        /** Reveal the meter of the hovered row and let the card morph to the new height. */
        private void ApplyRowHover()
        {
            // Driven purely by WPF's own Enter/Leave events. Re-checking the cursor position here
            // fought with those events (a click moves the pointer onto a row, and a click that
            // activates another window clears WPF's hover state), so the row id is the only input.
            var changed = false;
            foreach (var panel in _rowPanels)
            {
                var show = _meterRow != null
                    && panel.Row != null
                    && panel.Row.Id == _meterRow
                    && panel.Row.HasUsage;
                var wanted = show ? Visibility.Visible : Visibility.Collapsed;
                if (panel.Root.Visibility != wanted)
                {
                    panel.Root.Visibility = wanted;
                    changed = true;
                    Log((show ? "row meter open for " : "row meter closed for ")
                        + (panel.Row == null ? "?" : panel.Row.Id));
                }
            }
            if (!changed) return;
            MeasureSizes();
            ApplyState(true);
        }

        /** Whether the cursor sits inside a row container (kept for diagnostics). */
        private static string RowProbe(StackPanel container)
        {
            try
            {
                if (container == null || !container.IsVisible || container.ActualHeight <= 0) return "away: no container";
                WINPOINT cursor;
                if (!GetCursorPos(out cursor)) return "away: no cursor";
                var origin = container.PointToScreen(new Point(0, 0));
                var over = cursor.X >= origin.X - 2 && cursor.X <= origin.X + container.ActualWidth + 2
                    && cursor.Y >= origin.Y - 2 && cursor.Y <= origin.Y + container.ActualHeight + 2;
                return string.Format(CultureInfo.InvariantCulture,
                    "{0} cursor=({1},{2}) row=({3:0},{4:0},{5:0}x{6:0})",
                    over ? "over" : "away", cursor.X, cursor.Y, origin.X, origin.Y, container.ActualWidth, container.ActualHeight);
            }
            catch (Exception error)
            {
                return "away: " + error.Message;
            }
        }

        /** One legend item: a tinted dot plus its figure. */
        private static void AddLegend(UsagePanel panel, string label, double tokens, Brush tint)
        {
            var item = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 12, 0) };
            item.Children.Add(new Ellipse { Width = 6, Height = 6, Fill = tint, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 4, 0) });
            item.Children.Add(new TextBlock { Text = label + " " + FormatTokens(tokens), Foreground = SubBrush, FontSize = 10.5 });
            panel.Legend.Children.Add(item);
        }

        /** Size the three tinted segments across the filled part of the track. */
        private static void RebuildUsageBar(UsagePanel panel)
        {
            if (panel == null || panel.Segments == null || panel.Track == null || panel.Row == null) return;
            panel.Segments.Children.Clear();
            var width = panel.Track.ActualWidth;
            if (width <= 0) return;

            var source = panel.Row;
            var filled = width * Math.Max(0, Math.Min(100, source.UsagePercent)) / 100.0;
            var parts = new[]
            {
                new { Tokens = source.SystemTokens, Brush = SystemSegmentBrush },
                new { Tokens = source.ToolsTokens, Brush = ToolsSegmentBrush },
                new { Tokens = source.MessageTokens, Brush = MessageSegmentBrush }
            };
            var total = 0.0;
            foreach (var part in parts) total += part.Tokens;

            if (total <= 0)
            {
                panel.Segments.Children.Add(new Border { Width = filled, Height = 4, Background = FromHex("#8E9AAF"), CornerRadius = new CornerRadius(2) });
                return;
            }

            var used = 0.0;
            foreach (var part in parts)
            {
                if (part.Tokens <= 0) continue;
                var segment = filled * part.Tokens / total;
                used += segment;
                panel.Segments.Children.Add(new Border
                {
                    Width = segment, Height = 4, Background = part.Brush,
                    CornerRadius = new CornerRadius(1), Margin = new Thickness(0, 0, 1, 0)
                });
            }
            // Keep the bar's end flush when rounding left a sliver.
            var remainder = filled - used - Math.Max(0, panel.Segments.Children.Count - 1);
            if (remainder > 0.5)
            {
                panel.Segments.Children.Add(new Border { Width = remainder, Height = 4, Background = MessageSegmentBrush, CornerRadius = new CornerRadius(1) });
            }
        }

        /** Compact token figure: 1234 -> "1.2K", 250000 -> "250K", 1500000 -> "1.5M". */
        private static string FormatTokens(double tokens)
        {
            if (tokens < 1000) return Math.Round(tokens).ToString(CultureInfo.InvariantCulture);
            if (tokens < 10000) return (tokens / 1000).ToString("0.#", CultureInfo.InvariantCulture) + "K";
            if (tokens < 1000000) return Math.Round(tokens / 1000).ToString(CultureInfo.InvariantCulture) + "K";
            return (tokens / 1000000).ToString("0.#", CultureInfo.InvariantCulture) + "M";
        }

        private void RebuildRows()
        {
            _rows.Children.Clear();
            _rowPanels.Clear();
            _requestPanels.Clear();
            // WPF raises Enter again for whatever row the pointer is over, so forgetting the old
            // row here is what keeps the meter honest after the list changes.
            _hoverRow = null;
            _meterRow = null;
            _pendingMeterRow = null;
            _meterTimer.Stop();
            foreach (var row in _model)
            {
                var dotBrush = row.PendingKind != null ? DotWarningBrush : row.Running ? DotRunningBrush : DotDoneBrush;
                var dot = new Ellipse { Width = 7, Height = 7, Fill = dotBrush, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 5, 0, 0) };

                var titleRow = new StackPanel { Orientation = Orientation.Horizontal };
                titleRow.Children.Add(new TextBlock
                {
                    Text = row.Title.Length > 0 ? row.Title : Fallback(row),
                    Foreground = TitleBrush, FontSize = 12.5, FontWeight = FontWeights.Medium,
                    TextTrimming = TextTrimming.CharacterEllipsis
                });
                if (row.Main)
                {
                    // Mark the session the main view already shows, so a click that changes it is
                    // visible at a glance.
                    titleRow.Children.Add(new Border
                    {
                        Background = ChipBrush, CornerRadius = new CornerRadius(8), Height = 15,
                        Padding = new Thickness(6, 0, 6, 0), Margin = new Thickness(6, 0, 0, 0),
                        VerticalAlignment = VerticalAlignment.Center,
                        Child = new TextBlock { Text = "当前", Foreground = MutedBrush, FontSize = 10, VerticalAlignment = VerticalAlignment.Center }
                    });
                }

                var title = titleRow;
                var sub = new TextBlock
                {
                    Text = StateLabel(row) + " · " + Relative(row),
                    Foreground = SubBrush, FontSize = 11, Margin = new Thickness(0, 1, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis
                };
                var mainPanel = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(9, 0, 0, 0) };
                mainPanel.Children.Add(title);
                mainPanel.Children.Add(sub);

                var grid = new Grid();
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                Grid.SetColumn(dot, 0);
                Grid.SetColumn(mainPanel, 1);
                grid.Children.Add(dot);
                grid.Children.Add(mainPanel);

                // The × removes the task from the island (and must not open the session).
                var cross = new ShapePath
                {
                    Data = Geometry.Parse("M0 0 6 6 M6 0 0 6"),
                    Stroke = MutedBrush, StrokeThickness = 1.4,
                    StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round,
                    Width = 7, Height = 7, Stretch = Stretch.None,
                    HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center
                };
                var dismiss = new Border
                {
                    Width = 20, Height = 20, CornerRadius = new CornerRadius(10),
                    Background = Brushes.Transparent, Cursor = Cursors.Hand, Child = cross,
                    VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(6, 0, 0, 0),
                    ToolTip = "从灵动岛移除（有新动静会再出现）"
                };
                var dismissed = row;
                dismiss.MouseEnter += (s, e) => { dismiss.Background = DismissHoverBrush; cross.Stroke = DismissStrokeBrush; };
                dismiss.MouseLeave += (s, e) => { dismiss.Background = Brushes.Transparent; cross.Stroke = MutedBrush; };
                dismiss.MouseLeftButtonUp += (s, e) => { e.Handled = true; Dismiss(dismissed); };
                Grid.SetColumn(dismiss, 2);
                grid.Children.Add(dismiss);

                var rowBorder = new Border
                {
                    CornerRadius = new CornerRadius(10), Padding = new Thickness(8, 6, 8, 6),
                    Background = Brushes.Transparent, Cursor = Cursors.Hand, Child = grid
                    // No tooltip: hovering a row now opens that task's context meter right below
                    // it, and a tooltip would cover those figures.
                };
                var captured = row;
                rowBorder.MouseEnter += (s, e) => rowBorder.Background = RowHoverBrush;
                rowBorder.MouseLeave += (s, e) => rowBorder.Background = Brushes.Transparent;
                rowBorder.MouseLeftButtonUp += (s, e) => { e.Handled = true; Activate(captured.Id); };

                // The row plus its own context meter: hovering either one keeps the meter open,
                // and it sits between this task and the next (the requested placement).
                var meter = BuildUsagePanel(row);
                var container = new StackPanel { Orientation = Orientation.Vertical };
                container.Children.Add(rowBorder);
                container.Children.Add(meter.Root);
                // A pending request shows under its own task, with its own Allow / Deny buttons.
                if (row.PendingKind != null)
                {
                    var requestCard = BuildRequestPanel(row);
                    container.Children.Add(requestCard.Root);
                    _requestPanels.Add(requestCard);
                }
                meter.Container = container;
                // Hover is tracked on the row and on the meter itself, never on the whole
                // container: that container also holds the request card, and resting on
                // "Allow / Deny" must not open the context meter. A rebuilt list clears the
                // remembered row (see RebuildRows) so WPF decides again from its own events,
                // and the meter opens only after the pointer rested on the row for HoverDelayMs.
                foreach (var target in new UIElement[] { rowBorder, meter.Root })
                {
                    if (target == null) continue;
                    target.MouseEnter += (s, e) =>
                    {
                        _hoverRow = captured.Id;
                        if (_meterRow == captured.Id) { ApplyRowHover(); return; }
                        _meterTimer.Stop();
                        _pendingMeterRow = captured.Id;
                        if (_options.HoverDelayMs <= 0)
                        {
                            _meterRow = captured.Id;
                            ApplyRowHover();
                            return;
                        }
                        _meterTimer.Start();
                    };
                    target.MouseLeave += (s, e) =>
                    {
                        if (_hoverRow == captured.Id) _hoverRow = null;
                        if (_pendingMeterRow == captured.Id) { _pendingMeterRow = null; _meterTimer.Stop(); }
                        if (_meterRow == captured.Id)
                        {
                            _meterRow = null;
                            ApplyRowHover();
                        }
                    };
                }
                container.MouseLeave += (s, e) =>
                {
                    // Leaving the whole container (row + meter + request card) always closes it.
                    if (_hoverRow == captured.Id) _hoverRow = null;
                    if (_pendingMeterRow == captured.Id) { _pendingMeterRow = null; _meterTimer.Stop(); }
                    if (_meterRow == captured.Id)
                    {
                        _meterRow = null;
                        ApplyRowHover();
                    }
                };
                _rowPanels.Add(meter);
                _rows.Children.Add(container);
            }
            // A rebuilt list must keep whatever row the pointer is already resting on open.
            ApplyRowHover();
        }

        private void MeasureSizes()
        {
            // DesiredSize is only meaningful after a layout pass: showing or hiding a task's meter
            // invalidates the tree, and measuring before that pass returns the previous sizes,
            // which made the card height (and so the morph target) jump back and forth.
            UpdateLayout();

            // The collapsed pill is capped at MaxCollapsedWidth, so a long title must be trimmed
            // here — otherwise the badge, the running count and the chevron on its right are the
            // parts that get clipped, which reads as a missing piece on the island's right side.
            _title.MaxWidth = double.PositiveInfinity;
            _header.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            var unbounded = _header.DesiredSize.Width;
            var titleWidth = _title.DesiredSize.Width;
            var fixedWidth = Math.Max(0, unbounded - titleWidth);
            var allowedTitle = Math.Max(60, MaxCollapsedWidth - CollapsedPad.Left - CollapsedPad.Right - 2 * RootBorderThickness - fixedWidth);
            if (Math.Abs(_title.MaxWidth - allowedTitle) > 0.5)
            {
                _title.MaxWidth = allowedTitle;
                _header.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            }

            var collapsed = Math.Min(MaxCollapsedWidth, Math.Max(MinCollapsedWidth, _header.DesiredSize.Width + CollapsedPad.Left + CollapsedPad.Right + 2 * RootBorderThickness));
            _collapsedWidth = collapsed;

            // Both heights follow the header's own measurement (see the header's construction):
            // rendering it into a fixed 24 clipped the title's lower strokes.
            _headerHeight = Math.Max(HeaderHeight, _header.DesiredSize.Height);
            _collapsedHeight = _headerHeight + CollapsedPad.Top + CollapsedPad.Bottom + 2 * RootBorderThickness;

            _detail.Width = ExpandedContentWidth;
            _detail.Measure(new Size(_detail.Width, double.PositiveInfinity));
            var expanded = ExpandedPad.Top + ExpandedPad.Bottom + _headerHeight + _detail.DesiredSize.Height + 2 * RootBorderThickness;
            _expandedHeight = Math.Min(MaxCardHeight, Math.Max(_headerHeight + ExpandedPad.Top + ExpandedPad.Bottom + 10, expanded));

            // The window covers the island's largest footprint (in layout units - the scale
            // rides on the content transform), so a morph never has to resize the window.
            var requiredWidth = (Math.Max(ExpandedWidth, _collapsedWidth) + WindowSlack) * _scale;
            var requiredHeight = (_expandedHeight + WindowSlack) * _scale;
            var openRequest = 0.0;
            foreach (var card in _requestPanels) openRequest += card.Root.DesiredSize.Height;
            if (Math.Abs(requiredHeight - _windowHeight) > 0.5)
            {
                Log(string.Format(CultureInfo.InvariantCulture,
                    "measure: expanded={0:0.##} detail={1:0.##} rows={2:0.##} request={3:0.##} idle={4} pending={5} meter={6}",
                    _expandedHeight, _detail.DesiredSize.Height, _rows.DesiredSize.Height, openRequest,
                    _idle, FirstPending() != null, _rowPanels.Exists(p => p.Root.Visibility == Visibility.Visible)));
            }
            if (Math.Abs(requiredWidth - _windowWidth) > 0.5 || Math.Abs(requiredHeight - _windowHeight) > 0.5)
            {
                _windowWidth = requiredWidth;
                _windowHeight = requiredHeight;
                Width = requiredWidth;
                Height = requiredHeight;
                CentreHorizontally();
            }
        }

        private void Expand()
        {
            // A plain black block has nothing to open.
            if (_empty) return;
            _collapseTimer.Stop();
            if (!_expanded) Log($"pointer enter -> expand ({PointerState()})");
            _expanded = true;
            ApplyState(true);
        }

        private void ScheduleCollapse()
        {
            if (_expanded) Log($"pointer leave -> arm collapse ({PointerState()})");
            _collapseTimer.Stop();
            _collapseTimer.Start();
        }

        private void Collapse()
        {
            if (_model.Count == 0) return;
            _expanded = false;
            ApplyState(true);
        }

        /// <summary>Window rect plus cursor position, for explaining hover decisions.</summary>
        private string PointerState()
        {
            try
            {
                var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
                WINRECT rect;
                WINPOINT point;
                if (handle == IntPtr.Zero || !GetWindowRect(handle, out rect) || !GetCursorPos(out point))
                {
                    return $"mouseOver={IsMouseOver} rect=? cursor=?";
                }
                return $"mouseOver={IsMouseOver} rect=({rect.Left},{rect.Top})-({rect.Right},{rect.Bottom}) cursor=({point.X},{point.Y})";
            }
            catch (Exception error)
            {
                return "mouseOver=" + IsMouseOver + " probe failed: " + error.Message;
            }
        }

        private void ApplyState(bool animate)
        {
            // An animation is over once its duration has passed. This cannot be checked from the
            // rendering callback: WPF raises none while the picture is static, which left the flag
            // set and made every later update re-run the morph (size unchanged, morphRuns +1).
            if (_animating && (DateTime.UtcNow - _morphStartedAt).TotalMilliseconds > _morphDurationMs + 120)
            {
                _animating = false;
            }

            var targetWidth = _expanded ? ExpandedWidth : _collapsedWidth;
            var targetHeight = _expanded ? _expandedHeight : _collapsedHeight;

            // A collapsed island keeps a single line: the header is the only visible row.
            targetWidth = _expanded ? Math.Max(ExpandedWidth, _collapsedWidth) : _collapsedWidth;
            var targetPad = _expanded ? ExpandedPad : CollapsedPad;

            // With nothing to report the island is a plain black block: one small rounded shape,
            // no text, no padding.
            if (_empty)
            {
                targetWidth = EmptyWidth;
                targetHeight = EmptyHeight;
                targetPad = new Thickness(0);
            }

            // The page pushes about once a second. Re-animating toward an unchanged target
            // would flash the hidden detail back in (opacity 1 -> 0) and flip the chevron
            // every second, so an unchanged target and state is a no-op.
            var unchanged = _hasApplied
                && _appliedExpanded == _expanded
                && Math.Abs(targetWidth - _appliedWidth) < 0.5
                && Math.Abs(targetHeight - _appliedHeight) < 0.5
                && SamePadding(targetPad, _appliedPad);
            // An unchanged target is a no-op, full stop: there is nothing to animate, and letting a
            // stale "animating" flag re-drive it was exactly the per-poll restart (and flicker) the
            // island kept showing. A genuinely new target always takes the branch below.
            if (unchanged)
            {
                _animating = false;
                return;
            }
            if (!unchanged)
            {
                _lastMorphReason = string.Format(CultureInfo.InvariantCulture,
                    "{0:0.##}x{1:0.##}->{2:0.##}x{3:0.##} exp{4}->{5} pad {6}->{7} (at {8:HH:mm:ss.fff})",
                    _appliedWidth, _appliedHeight, targetWidth, targetHeight, _appliedExpanded, _expanded,
                    _appliedPad, targetPad, DateTime.Now);
                Log("morph target changed: " + _lastMorphReason);
            }

            _hasApplied = true;
            _appliedWidth = targetWidth;
            _appliedHeight = targetHeight;
            _appliedPad = targetPad;
            _appliedExpanded = _expanded;

            if (!animate)
            {
                _animating = false;
                _root.BeginAnimation(WidthProperty, null);
                _root.BeginAnimation(HeightProperty, null);
                _root.BeginAnimation(PaddingProperty, null);
                _root.BeginAnimation(Border.CornerRadiusProperty, null);
                _detail.BeginAnimation(OpacityProperty, null);
                _chevronRotate.BeginAnimation(RotateTransform.AngleProperty, null);
                _root.Width = targetWidth;
                _root.Height = targetHeight;
                _root.Padding = targetPad;
                _detail.Opacity = _expanded ? 1 : 0;
                _root.CornerRadius = new CornerRadius(_empty ? EmptyHeight / 2 : (_expanded ? 20 : 17));
                _chevronRotate.Angle = _expanded ? 180 : 0;
                return;
            }

            // Real WPF animations: driven by the composition clock (vsync) instead of a
            // 16 ms DispatcherTimer, and leaving From unset makes each one start from the
            // value currently on screen, so a mid-flight retarget stays continuous.
            var duration = TimeSpan.FromMilliseconds(_expanded ? MorphMs : CollapseMs);
            var ease = new CubicEase { EasingMode = EasingMode.EaseInOut };
            _animating = true;
            _morphStartedAt = DateTime.UtcNow;
            _morphDurationMs = duration.TotalMilliseconds;
            _morphRuns++;
            TrackFrames();

            Animate(_root, WidthProperty, targetWidth, duration, ease);
            Animate(_root, HeightProperty, targetHeight, duration, ease);
            Animate(_root, PaddingProperty, targetPad, duration, ease);
            Animate(_detail, OpacityProperty, _expanded ? 1d : 0d, duration, ease);
            Animate(_chevronRotate, RotateTransform.AngleProperty, _expanded ? 180d : 0d, duration, ease);
            // WPF has no CornerRadius animation type; a 3px radius change reads as instant
            // either way, so it is set rather than animated.
            _root.CornerRadius = new CornerRadius(_empty ? EmptyHeight / 2 : (_expanded ? 20 : 17));
        }

        /// <summary>Start one animation and settle on the exact target when it ends.</summary>
        private void Animate(DependencyObject target, DependencyProperty property, double to, TimeSpan duration, IEasingFunction ease)
        {
            Animate(target, property, (object)to, duration, ease);
        }

        private void Animate(DependencyObject target, DependencyProperty property, object to, TimeSpan duration, IEasingFunction ease)
        {
            var animatable = target as IAnimatable;
            if (animatable == null) return;

            AnimationTimeline animation;
            if (to is double)
            {
                animation = new DoubleAnimation((double)to, duration) { EasingFunction = ease };
            }
            else if (to is Thickness)
            {
                animation = new ThicknessAnimation((Thickness)to, duration) { EasingFunction = ease };
            }
            else
            {
                return;
            }

            animation.Completed += (s, e) =>
            {
                animatable.BeginAnimation(property, null);
                target.SetValue(property, to);
            };
            animatable.BeginAnimation(property, animation);
        }

        /// <summary>Count real frames while an animation runs, so smoothness is measurable.</summary>
        private void TrackFrames()
        {
            _frameCount = 0;
            _lastFrameAt = DateTime.MinValue;
            _maxFrameGapMs = 0;
            CompositionTarget.Rendering -= OnRendering;
            CompositionTarget.Rendering += OnRendering;
        }

        private void OnRendering(object sender, EventArgs e)
        {
            var now = DateTime.UtcNow;
            if (_lastFrameAt != DateTime.MinValue)
            {
                var gap = (now - _lastFrameAt).TotalMilliseconds;
                if (gap > _maxFrameGapMs) _maxFrameGapMs = gap;
            }
            _lastFrameAt = now;
            _frameCount++;
        }

        private static bool SamePadding(Thickness left, Thickness right)
        {
            return Math.Abs(left.Left - right.Left) < 0.01
                && Math.Abs(left.Top - right.Top) < 0.01
                && Math.Abs(left.Right - right.Right) < 0.01
                && Math.Abs(left.Bottom - right.Bottom) < 0.01;
        }

        // ------------------------------------------------------------------ text

        private TaskRow Primary()
        {
            foreach (var row in _model) if (row.PendingKind != null) return row;
            foreach (var row in _model) if (row.Running) return row;
            return _model.Count > 0 ? _model[0] : null;
        }

        private TaskRow FirstPending()
        {
            foreach (var row in _model) if (row.PendingKind != null) return row;
            return null;
        }

        private string CompactLabel(out string text)
        {
            var pending = FirstPending();
            if (pending != null)
            {
                text = pending.Title.Length > 0 ? pending.Title : Fallback(pending);
                return text;
            }
            var running = new List<TaskRow>();
            foreach (var row in _model) if (row.Running) running.Add(row);
            if (running.Count == 1)
            {
                text = running[0].Title.Length > 0 ? running[0].Title : Fallback(running[0]);
                return text;
            }
            if (running.Count > 1)
            {
                text = string.Format(CultureInfo.InvariantCulture, "{0} 个任务正在执行", running.Count);
                return text;
            }
            text = string.Format(CultureInfo.InvariantCulture, "{0} 个任务已完成", _model.Count);
            return text;
        }

        private static string BadgeText(string kind)
        {
            switch (kind)
            {
                case "approval": return "待批准";
                case "question": return "待回答";
                case "plan-review": return "待确认";
                default: return "待处理";
            }
        }

        private string StateLabel(TaskRow row)
        {
            switch (row.PendingKind)
            {
                case "approval": return "等待批准";
                case "question": return "等待回答";
                case "plan-review": return "等待确认";
                default: break;
            }
            if (row.Running) return row.Children > 0
                ? string.Format(CultureInfo.InvariantCulture, "正在执行 · {0} 个子任务", row.Children)
                : "正在执行";
            if (row.JobsRunning > 0) return string.Format(CultureInfo.InvariantCulture, "后台任务 {0}", row.JobsRunning);
            return _idle ? "空闲" : "已完成";
        }

        private string Relative(TaskRow row)
        {
            var stamp = row.UpdatedAt > 0 ? row.UpdatedAt : row.StartedAt;
            if (stamp <= 0) return "";
            var seconds = Math.Max(0, (Now() - stamp) / 1000.0);
            if (seconds < 5) return "刚刚更新";
            if (seconds < 60) return string.Format(CultureInfo.InvariantCulture, "{0} 秒前更新", (int)seconds);
            var minutes = (int)(seconds / 60);
            if (minutes < 60) return string.Format(CultureInfo.InvariantCulture, "{0} 分钟前更新", minutes);
            return string.Format(CultureInfo.InvariantCulture, "{0} 小时前更新", minutes / 60);
        }

        private static double Now()
        {
            return (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        private static string Fallback(TaskRow row)
        {
            if (row.Cwd.Length > 0)
            {
                var trimmed = row.Cwd.TrimEnd('\\', '/');
                var index = trimmed.LastIndexOfAny(new[] { '\\', '/' });
                if (index >= 0 && index + 1 < trimmed.Length) return trimmed.Substring(index + 1);
                return trimmed;
            }
            return row.Id;
        }

        private static string Truncate(string value, int limit)
        {
            if (value == null) return "";
            return value.Length <= limit ? value : value.Substring(0, limit) + "...";
        }

        // ------------------------------------------------------------------ actions

        private void Activate(string sessionId)
        {
            // Queue the request in this overlay's own /focus queue: the Harness page polls that
            // endpoint (it is the one whose /health identifies this overlay) and turns a taken
            // id into uiWorkspace.openSession. Posting to the optional host endpoint instead
            // would leave the id on a queue nobody reads.
            if (!string.IsNullOrEmpty(sessionId))
            {
                lock (_focusLock) _pendingFocus = sessionId;
                Log("queued focus for " + sessionId);
            }
            else
            {
                Log("row click without a session id");
            }
            // Activating another window can involve short waits, so it stays off the UI thread.
            ThreadPool.QueueUserWorkItem(_ => FocusHarnessWindow());
        }

        private void FocusHarnessWindow()
        {
            try
            {
                var handle = FindHarnessWindow();
                if (handle == IntPtr.Zero)
                {
                    Log("focus window: no visible '" + _options.HarnessProcess + "' window found");
                    return;
                }
                var restored = ForceForeground(handle);
                Log(string.Format(CultureInfo.InvariantCulture,
                    "focus window: 0x{0:X} foreground={1} minimized={2} (was minimized: {3})",
                    handle.ToInt64(), GetForegroundWindow() == handle, IsIconic(handle), restored));
            }
            catch (Exception error)
            {
                Log("focus window failed: " + error.Message);
            }
        }

        /// <summary>
        /// Un-minimize a window owned by another thread.
        ///
        /// A plain ShowWindow(SW_RESTORE) is silently dropped here (measured: the window is still
        /// iconic right after the call), so the cross-thread ShowWindowAsync is used and, if the
        /// owner's message loop still has not acted, SC_RESTORE is posted to it directly.
        /// </summary>
        private void RestoreWindow(IntPtr handle)
        {
            if (!IsIconic(handle)) return;
            ShowWindowAsync(handle, SW_RESTORE);
            for (var attempt = 0; attempt < 8 && IsIconic(handle); attempt += 1) Thread.Sleep(40);
            if (IsIconic(handle))
            {
                PostMessage(handle, WM_SYSCOMMAND, SC_RESTORE, IntPtr.Zero);
                for (var attempt = 0; attempt < 8 && IsIconic(handle); attempt += 1) Thread.Sleep(40);
            }
            if (IsIconic(handle)) ShowWindow(handle, SW_RESTORE);
        }

        /// <summary>
        /// The harness's main window: the largest visible top-level window of those processes.
        ///
        /// Electron runs many helper processes, several of which own small hidden top-level
        /// windows; activating one of those looks like "nothing happened", so the window is
        /// chosen by what a person would actually see.
        /// </summary>
        private IntPtr FindHarnessWindow()
        {
            var wanted = new HashSet<uint>();
            var names = new List<string>();
            try
            {
                foreach (var process in Process.GetProcessesByName(_options.HarnessProcess))
                {
                    wanted.Add((uint)process.Id);
                    names.Add(process.Id.ToString(CultureInfo.InvariantCulture));
                }
            }
            catch (Exception error)
            {
                Log("focus window: process lookup failed: " + error.Message);
            }

            var byTitle = IntPtr.Zero;
            var byTitleArea = 0L;
            var minimizedTitle = IntPtr.Zero;
            var byProcess = IntPtr.Zero;
            var byProcessArea = 0L;
            var minimizedProcess = IntPtr.Zero;
            EnumWindows((hwnd, _) =>
            {
                if (!IsWindowVisible(hwnd)) return true;
                if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;

                // A minimized window reports its placeholder rectangle (around -32000), so the
                // size test would throw it away - yet restoring it is exactly what a click on a
                // task should do. Minimized candidates are kept aside and used as a fallback.
                var minimized = IsIconic(hwnd);
                long area = 0;
                if (!minimized)
                {
                    WINRECT rect;
                    if (!GetWindowRect(hwnd, out rect)) return true;
                    var width = rect.Right - rect.Left;
                    var height = rect.Bottom - rect.Top;
                    if (width < 200 || height < 150) return true;
                    area = (long)width * height;
                }

                var titled = TitleOf(hwnd).IndexOf(_options.HarnessProcess, StringComparison.OrdinalIgnoreCase) >= 0;
                if (titled)
                {
                    if (minimized) { if (minimizedTitle == IntPtr.Zero) minimizedTitle = hwnd; }
                    else if (area > byTitleArea) { byTitleArea = area; byTitle = hwnd; }
                    return true;
                }

                uint owner;
                GetWindowThreadProcessId(hwnd, out owner);
                if (!wanted.Contains(owner)) return true;
                if (minimized) { if (minimizedProcess == IntPtr.Zero) minimizedProcess = hwnd; }
                else if (area > byProcessArea) { byProcessArea = area; byProcess = hwnd; }
                return true;
            }, IntPtr.Zero);

            var best = byTitle != IntPtr.Zero ? byTitle
                : byProcess != IntPtr.Zero ? byProcess
                : minimizedTitle != IntPtr.Zero ? minimizedTitle
                : minimizedProcess;
            if (best == IntPtr.Zero)
            {
                var scan = new List<string>();
                var total = 0;
                EnumWindows((hwnd, _) =>
                {
                    total++;
                    if (scan.Count < 8 && IsWindowVisible(hwnd))
                    {
                        var t = TitleOf(hwnd);
                        if (t.Length > 0) scan.Add("'" + (t.Length > 40 ? t.Substring(0, 40) : t) + "'");
                    }
                    return true;
                }, IntPtr.Zero);
                Log(string.Format(CultureInfo.InvariantCulture,
                    "focus window: no window titled '{0}' and no window of pid(s) [{1}]; scanned={2} visible={3}",
                    _options.HarnessProcess, string.Join(", ", names), total, string.Join(" ", scan)));
            }
            return best;
        }

        private static string TitleOf(IntPtr hwnd)
        {
            var length = GetWindowTextLength(hwnd);
            if (length <= 0) return "";
            var buffer = new StringBuilder(length + 2);
            GetWindowText(hwnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        /// <summary>
        /// Bring a window to the foreground from a background process.
        ///
        /// Windows refuses plain SetForegroundWindow calls from a process that is not already in
        /// front, so this attaches to the foreground thread and, if that is still not enough,
        /// taps Alt first - the documented way to make the request count as user input.
        /// </summary>
        private bool ForceForeground(IntPtr handle)
        {
            var wasMinimized = IsIconic(handle);
            // SW_SHOW does not un-minimize; the restore must happen before any early return, and
            // a minimized window can already count as the foreground window.
            RestoreWindow(handle);

            var foreground = GetForegroundWindow();
            if (foreground == handle && !IsIconic(handle))
            {
                Log(string.Format(CultureInfo.InvariantCulture,
                    "focus window: 0x{0:X} already in front (was minimized: {1})", handle.ToInt64(), wasMinimized));
                return wasMinimized;
            }

            var currentThread = GetCurrentThreadId();
            var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
            var attached = false;
            try
            {
                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    attached = AttachThreadInput(currentThread, foregroundThread, true);
                }
                BringWindowToTop(handle);
                SetForegroundWindow(handle);
            }
            finally
            {
                if (attached) AttachThreadInput(currentThread, foregroundThread, false);
            }

            if (GetForegroundWindow() == handle && !IsIconic(handle)) return wasMinimized;

            // Still behind (or still iconic): a synthetic Alt tap clears the foreground lock.
            keybd_event(VK_MENU, 0, 0, IntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, IntPtr.Zero);
            SetForegroundWindow(handle);
            RestoreWindow(handle);
            return wasMinimized;
        }

        // ------------------------------------------------------------------ animation helpers

        private static void Pulse(UIElement element)
        {
            var opacity = new System.Windows.Media.Animation.DoubleAnimation
            {
                From = 0.55, To = 0, Duration = TimeSpan.FromMilliseconds(1500),
                RepeatBehavior = System.Windows.Media.Animation.RepeatBehavior.Forever
            };
            var scaleX = new System.Windows.Media.Animation.DoubleAnimation
            {
                From = 0.6, To = 1.5, Duration = TimeSpan.FromMilliseconds(1500),
                RepeatBehavior = System.Windows.Media.Animation.RepeatBehavior.Forever
            };
            var scaleY = scaleX.Clone();
            element.RenderTransformOrigin = new Point(0.5, 0.5);
            element.RenderTransform = new ScaleTransform(1, 1);
            ((ScaleTransform)element.RenderTransform).BeginAnimation(ScaleTransform.ScaleXProperty, scaleX);
            ((ScaleTransform)element.RenderTransform).BeginAnimation(ScaleTransform.ScaleYProperty, scaleY);
            element.BeginAnimation(OpacityProperty, opacity);
        }

        /// <summary>Start or stop the attention ring without fighting a running animation.</summary>
        private void SetPulse(bool on)
        {
            if (on == _pulseOn) return;
            _pulseOn = on;
            if (on)
            {
                Pulse(_dotRing);
                return;
            }
            _dotRing.BeginAnimation(OpacityProperty, null);
            _dotRing.Opacity = 0;
        }

        // ------------------------------------------------------------------ logging

        private void WriteReport(Snapshot snapshot)
        {
            // Settle the layout first: the report mixes laid-out values (pill size) with live ones
            // (meter visibility), and reading them across a pending layout pass made the two
            // disagree - which reads as a size change that never happened.
            try { UpdateLayout(); } catch { /* a report must never break the island */ }
            var report = new StringBuilder();
            report.AppendLine("probe at " + DateTime.Now.ToString("O", CultureInfo.InvariantCulture));
            report.AppendLine("hostUrl: " + (_hostUrl ?? "(none: page push only)"));
            report.AppendLine("discovery: " + _options.DiscoveryPath);
            report.AppendLine("pushPort: " + (_server == null ? "(none)" : _server.Port.ToString(CultureInfo.InvariantCulture)));
            report.AppendLine("pushAge: " + (_pushedJson == null ? "(never)" : (DateTime.UtcNow - _pushedAt).TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture) + "s"));
            report.AppendLine("ok: " + snapshot.Ok);
            if (!snapshot.Ok) report.AppendLine("error: " + snapshot.Error);
            report.AppendLine("pollCount: " + _pollCount);
            report.AppendLine("tasks: " + snapshot.Rows.Count);
            foreach (var row in snapshot.Rows)
            {
                report.AppendLine(string.Format(CultureInfo.InvariantCulture,
                    "  - id={0} running={1} pending={2} jobs={3} children={4} title={5} cwd={6}",
                    row.Id, row.Running, row.PendingKind ?? "-", row.JobsRunning, row.Children, row.Title, row.Cwd));
            }
            report.AppendLine("window.visible: " + Visibility);
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "window.rect: left={0:0.##} top={1:0.##} width={2:0.##} height={3:0.##}",
                Left, Top, ActualWidth, ActualHeight));
            report.AppendLine("window.topmost: " + Topmost);
            report.AppendLine("collapsedWidth: " + _collapsedWidth.ToString("0.##", CultureInfo.InvariantCulture));
            report.AppendLine("expandedHeight: " + _expandedHeight.ToString("0.##", CultureInfo.InvariantCulture));
            report.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "expandedRect: left={0:0.##} top={1:0.##} width={2:0.##} height={3:0.##}",
                Math.Max(0, (SystemParameters.PrimaryScreenWidth - Math.Max(ExpandedWidth, _collapsedWidth)) / 2.0), Top,
                Math.Max(ExpandedWidth, _collapsedWidth), _expandedHeight));
            report.AppendLine("headerText: " + _title.Text);
            // True when the collapsed pill really shows its whole header (dot, title, badge,
            // count, chevron). A long title used to push the chevron out of the pill's cap.
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "headerFits: {0}",
                _header.DesiredSize.Width + CollapsedPad.Left + CollapsedPad.Right + 2 * RootBorderThickness <= _collapsedWidth + 0.5));
            // True when the collapsed pill is tall enough for the header it must show. A fixed
            // height used to cut the lower half of the title off.
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "headerHeight: {0:0.##}", _headerHeight));
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "collapsedHeight: {0:0.##}", _collapsedHeight));
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "headerFitsVertically: {0}",
                _headerHeight + 0.5 >= _header.DesiredSize.Height));
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "titleBox: {0:0.##}x{1:0.##} font={2}", _title.ActualWidth, _title.ActualHeight, _title.FontFamily.Source));
            report.AppendLine("titleMaxWidth: " + _title.MaxWidth.ToString("0.##", CultureInfo.InvariantCulture));
            report.AppendLine("badge: " + (_badge.Visibility == Visibility.Visible ? _badgeText.Text : "(none)"));
            report.AppendLine("rows: " + _rows.Children.Count);
            report.AppendLine("dismissed: " + _dismissed.Count);
            report.AppendLine("usageVisible: " + (_rowPanels.Exists(panel => panel.Root.Visibility == Visibility.Visible) ? "Visible" : "Collapsed"));
            report.AppendLine("usageRow: " + (_meterRow ?? "(none)"));
            var requestRow = "(none)";
            foreach (var card in _requestPanels) { if (card.Row != null) { requestRow = card.Row.Id; break; } }
            report.AppendLine("requestCount: " + _requestPanels.Count.ToString(CultureInfo.InvariantCulture));
            report.AppendLine("requestRow: " + requestRow);
            report.AppendLine("requestHead: " + (_requestPanels.Count > 0 ? _requestPanels[0].Head.Text : ""));
            var openMeter = 0.0;
            foreach (var panel in _rowPanels)
            {
                if (panel.Root.Visibility == Visibility.Visible) openMeter = panel.Root.DesiredSize.Height;
            }
            report.AppendLine(string.Format(CultureInfo.InvariantCulture,
                "measured: detail={0:0.##} rows={1:0.##} usage={2:0.##} header={3:0.##}",
                _detail.DesiredSize.Height, _rows.DesiredSize.Height, openMeter, _header.DesiredSize.Height));
            report.AppendLine("scale: " + _scale.ToString("0.##", CultureInfo.InvariantCulture));
            report.AppendLine("morphRuns: " + _morphRuns.ToString(CultureInfo.InvariantCulture));
            report.AppendLine("lastMorph: " + _lastMorphReason);
            report.AppendLine("expanded: " + _expanded);
            report.AppendLine("idle: " + _idle);
            report.AppendLine("empty: " + _empty);
            report.AppendLine("alwaysShow: " + _options.AlwaysShow);
            report.AppendLine("chevronAngle: " + _chevronRotate.Angle.ToString("0.#", CultureInfo.InvariantCulture));
            // Smoothness evidence: the render-clock frames seen during the last morph.
            report.AppendLine("frames: " + _frameCount.ToString(CultureInfo.InvariantCulture));
            report.AppendLine("maxFrameGap: " + _maxFrameGapMs.ToString("0.#", CultureInfo.InvariantCulture));
            // The pill's own geometry, since the window keeps its full footprint either way.
            // Reported in on-screen units: the scale rides on a LayoutTransform, so the pill's
            // layout width is scale-independent while what a person sees is not.
            var pillWidth = (_root.ActualWidth > 0 ? _root.ActualWidth : _root.Width) * _scale;
            var pillHeight = (_root.ActualHeight > 0 ? _root.ActualHeight : _root.Height) * _scale;
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "pillWidth: {0:0.##}", pillWidth));
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "pillHeight: {0:0.##}", pillHeight));
            report.AppendLine(string.Format(CultureInfo.InvariantCulture, "windowSize: {0:0.##}x{1:0.##}", Width, Height));
            try
            {
                var handle = new System.Windows.Interop.WindowInteropHelper(this).Handle;
                var style = GetWindowLong(handle, GWL_EXSTYLE);
                report.AppendLine("hwnd: 0x" + handle.ToInt64().ToString("X", CultureInfo.InvariantCulture));
                report.AppendLine("win32Visible: " + IsWindowVisible(handle));
                report.AppendLine("wpfVisibility: " + Visibility);
                report.AppendLine("wpfIsVisible: " + IsVisible);
                report.AppendLine("opacity: " + Opacity.ToString("0.##", CultureInfo.InvariantCulture));
                report.AppendLine("exStyle: 0x" + style.ToString("X8", CultureInfo.InvariantCulture));
                report.AppendLine("toolWindow: " + ((style & WS_EX_TOOLWINDOW) != 0));
                report.AppendLine("noActivate: " + ((style & WS_EX_NOACTIVATE) != 0));
            }
            catch (Exception error)
            {
                report.AppendLine("exStyle: unavailable (" + error.Message + ")");
            }
            var text = report.ToString();
            var target = string.IsNullOrEmpty(_options.ReportPath) ? _options.LogPath : _options.ReportPath;
            lock (_logLock)
            {
                try
                {
                    Directory.CreateDirectory(IoPath.GetDirectoryName(target));
                    File.WriteAllText(target, text, Encoding.UTF8);
                }
                catch { }
            }
        }

        private void Log(string message)
        {
            lock (_logLock)
            {
                try
                {
                    Directory.CreateDirectory(IoPath.GetDirectoryName(_options.LogPath));
                    File.AppendAllText(_options.LogPath,
                        DateTime.Now.ToString("O", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine, Encoding.UTF8);
                }
                catch { }
            }
        }

        // ------------------------------------------------------------------ win32

        private const int GWL_EXSTYLE = -20;
        private const int WS_EX_TOOLWINDOW = 0x00000080;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int SW_HIDE = 0;
        private const int SW_SHOWNOACTIVATE = 4;
        private const int SW_SHOW = 5;
        private const int SW_RESTORE = 9;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool BringWindowToTop(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextLength(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern IntPtr GetWindow(IntPtr hWnd, uint command);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, IntPtr extra);

        private const uint GW_OWNER = 4;
        private const byte VK_MENU = 0x12;
        private const uint KEYEVENTF_KEYUP = 0x0002;

        [DllImport("user32.dll")]
        private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

        private const uint WM_SYSCOMMAND = 0x0112;
        private static readonly IntPtr SC_RESTORE = new IntPtr(0xF120);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out WINRECT rect);

        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out WINPOINT point);

        [StructLayout(LayoutKind.Sequential)]
        private struct WINRECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct WINPOINT { public int X, Y; }

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        private static Brush FromHex(string hex)
        {
            var value = hex.TrimStart('#');
            if (value.Length == 8)
            {
                var alpha = byte.Parse(value.Substring(0, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                var red = byte.Parse(value.Substring(2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                var green = byte.Parse(value.Substring(4, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                var blue = byte.Parse(value.Substring(6, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                var brush = new SolidColorBrush(Color.FromArgb(alpha, red, green, blue));
                brush.Freeze();
                return brush;
            }
            var solid = (SolidColorBrush)new BrushConverter().ConvertFromString(hex);
            solid.Freeze();
            return solid;
        }
    }
}
