using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Windows.Forms;

namespace ClaudeDeepSeekProxyManager
{
    public enum TrayMenuGlyph
    {
        Open,
        Start,
        Stop,
        Exit
    }

    public sealed class TrayMenuColorTable : ProfessionalColorTable
    {
        public TrayMenuColorTable()
        {
            UseSystemColors = false;
        }

        public override Color ToolStripDropDownBackground { get { return Color.FromArgb(252, 253, 255); } }
        public override Color ImageMarginGradientBegin { get { return Color.FromArgb(252, 253, 255); } }
        public override Color ImageMarginGradientMiddle { get { return Color.FromArgb(252, 253, 255); } }
        public override Color ImageMarginGradientEnd { get { return Color.FromArgb(252, 253, 255); } }
        public override Color MenuBorder { get { return Color.FromArgb(216, 224, 239); } }
        public override Color MenuItemBorder { get { return Color.FromArgb(205, 217, 244); } }
        public override Color MenuItemSelected { get { return Color.FromArgb(237, 243, 255); } }
        public override Color MenuItemSelectedGradientBegin { get { return Color.FromArgb(237, 243, 255); } }
        public override Color MenuItemSelectedGradientEnd { get { return Color.FromArgb(237, 243, 255); } }
        public override Color MenuItemPressedGradientBegin { get { return Color.FromArgb(225, 234, 253); } }
        public override Color MenuItemPressedGradientMiddle { get { return Color.FromArgb(225, 234, 253); } }
        public override Color MenuItemPressedGradientEnd { get { return Color.FromArgb(225, 234, 253); } }
        public override Color SeparatorDark { get { return Color.FromArgb(228, 234, 244); } }
        public override Color SeparatorLight { get { return Color.FromArgb(255, 255, 255); } }
    }

    public sealed class TrayMenuRenderer : ToolStripProfessionalRenderer
    {
        private static readonly Color BackgroundColor = Color.FromArgb(252, 253, 255);
        private static readonly Color BorderColor = Color.FromArgb(216, 224, 239);
        private static readonly Color HoverColor = Color.FromArgb(237, 243, 255);
        private static readonly Color PressedColor = Color.FromArgb(225, 234, 253);
        private static readonly Color TextColor = Color.FromArgb(38, 52, 78);
        private static readonly Color DisabledTextColor = Color.FromArgb(154, 165, 184);

        public TrayMenuRenderer()
            : base(new TrayMenuColorTable())
        {
            RoundedEdges = false;
        }

        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            using (GraphicsPath path = CreateRoundedPath(bounds, 10))
            using (SolidBrush brush = new SolidBrush(BackgroundColor))
            {
                e.Graphics.FillPath(brush, path);
            }
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            using (GraphicsPath path = CreateRoundedPath(bounds, 10))
            using (Pen pen = new Pen(BorderColor, 1f))
            {
                e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
        {
            using (SolidBrush brush = new SolidBrush(BackgroundColor))
            {
                e.Graphics.FillRectangle(brush, e.AffectedBounds);
            }
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected || !e.Item.Enabled) return;

            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(4, 1, e.Item.Width - 8, e.Item.Height - 2);
            using (GraphicsPath path = CreateRoundedPath(bounds, 7))
            using (SolidBrush brush = new SolidBrush(e.Item.Pressed ? PressedColor : HoverColor))
            {
                e.Graphics.FillPath(brush, path);
            }
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.ContentRectangle.Top + (e.Item.ContentRectangle.Height / 2);
            using (Pen pen = new Pen(Color.FromArgb(228, 234, 244), 1f))
            {
                e.Graphics.DrawLine(pen, 38, y, e.Item.Width - 10, y);
            }
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? TextColor : DisabledTextColor;
            base.OnRenderItemText(e);
        }

        public static GraphicsPath CreateRoundedPath(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            if (bounds.Width <= 0 || bounds.Height <= 0)
            {
                return path;
            }

            int diameter = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
            if (diameter <= 1)
            {
                path.AddRectangle(bounds);
                return path;
            }

            Rectangle arc = new Rectangle(bounds.Left, bounds.Top, diameter, diameter);
            path.AddArc(arc, 180, 90);
            arc.X = bounds.Right - diameter;
            path.AddArc(arc, 270, 90);
            arc.Y = bounds.Bottom - diameter;
            path.AddArc(arc, 0, 90);
            arc.X = bounds.Left;
            path.AddArc(arc, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    public static class TrayMenuTheme
    {
        public static ContextMenuStrip CreateMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.AutoSize = true;
            menu.BackColor = Color.FromArgb(252, 253, 255);
            menu.ForeColor = Color.FromArgb(38, 52, 78);
            menu.Font = new Font("Microsoft YaHei UI", 9.25f, FontStyle.Regular, GraphicsUnit.Point);
            menu.Padding = new Padding(8, 7, 8, 7);
            menu.MinimumSize = new Size(188, 0);
            menu.ShowCheckMargin = false;
            menu.ShowImageMargin = true;
            menu.ImageScalingSize = new Size(18, 18);
            menu.Renderer = new TrayMenuRenderer();
            menu.DropShadowEnabled = true;
            menu.Opened += ApplyRoundedRegion;
            return menu;
        }

        public static ToolStripMenuItem CreateItem(
            string text,
            TrayMenuGlyph glyph,
            Color glyphColor,
            bool emphasized)
        {
            ToolStripMenuItem item = new ToolStripMenuItem(text);
            item.AutoSize = true;
            item.ForeColor = Color.FromArgb(38, 52, 78);
            item.Image = CreateGlyph(glyph, glyphColor);
            item.ImageScaling = ToolStripItemImageScaling.None;
            item.Margin = new Padding(0, 1, 0, 1);
            item.Padding = new Padding(6, 5, 12, 5);
            item.TextAlign = ContentAlignment.MiddleLeft;
            item.ImageAlign = ContentAlignment.MiddleCenter;
            if (emphasized)
            {
                item.Font = new Font(item.Font, FontStyle.Bold);
            }
            return item;
        }

        public static ToolStripSeparator CreateSeparator()
        {
            ToolStripSeparator separator = new ToolStripSeparator();
            separator.AutoSize = false;
            separator.Height = 13;
            separator.Margin = Padding.Empty;
            return separator;
        }

        private static void ApplyRoundedRegion(object sender, EventArgs e)
        {
            ContextMenuStrip menu = sender as ContextMenuStrip;
            if (menu == null || menu.Width <= 0 || menu.Height <= 0) return;

            using (GraphicsPath path = TrayMenuRenderer.CreateRoundedPath(
                new Rectangle(0, 0, menu.Width, menu.Height), 10))
            {
                Region previous = menu.Region;
                menu.Region = new Region(path);
                if (previous != null) previous.Dispose();
            }
        }

        private static Bitmap CreateGlyph(TrayMenuGlyph glyph, Color color)
        {
            Bitmap bitmap = new Bitmap(18, 18, PixelFormat.Format32bppPArgb);
            bitmap.SetResolution(96, 96);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            using (SolidBrush brush = new SolidBrush(color))
            using (FontFamily iconFontFamily = ResolveIconFontFamily())
            using (Font font = new Font(iconFontFamily, 13f, FontStyle.Regular, GraphicsUnit.Pixel))
            using (StringFormat format = new StringFormat())
            {
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                string glyphText = glyph == TrayMenuGlyph.Open ? "\uE8A7"
                    : glyph == TrayMenuGlyph.Start ? "\uE768"
                    : glyph == TrayMenuGlyph.Stop ? "\uE71A"
                    : "\uE7E8";
                graphics.DrawString(glyphText, font, brush, new RectangleF(0f, 0f, 18f, 18f), format);
            }
            return bitmap;
        }

        private static FontFamily ResolveIconFontFamily()
        {
            try
            {
                return new FontFamily("Segoe Fluent Icons");
            }
            catch
            {
                return new FontFamily("Segoe MDL2 Assets");
            }
        }
    }
}
