using System;
using System.Runtime.InteropServices;

/// <summary>
/// Volume Windows par PID (Core Audio ISimpleAudioVolume) — toutes les sorties render.
/// </summary>
public static class HubVolumeMixer
{
    /// <summary>
    /// CLI rapide (évite PowerShell à chaque slider) :
    ///   hub-volume-mixer.exe set &lt;pid&gt; &lt;percent&gt;
    ///   hub-volume-mixer.exe mute &lt;pid&gt; &lt;0|1&gt;
    ///   hub-volume-mixer.exe apply &lt;pid&gt; &lt;percent&gt; &lt;0|1&gt;  (volume + mute atomique)
    ///   hub-volume-mixer.exe identity &lt;pid&gt; &lt;displayName&gt; &lt;iconPath&gt;
    /// </summary>
    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            if (args == null || args.Length < 1)
            {
                Console.Error.WriteLine("usage: set|mute|apply|identity ...");
                return 2;
            }
            string cmd = args[0].Trim().ToLowerInvariant();
            if (cmd == "set" && args.Length >= 3)
            {
                int pid = int.Parse(args[1]);
                float pct = float.Parse(args[2], System.Globalization.CultureInfo.InvariantCulture);
                Console.WriteLine(SetApplicationVolume(pid, pct));
                return 0;
            }
            if (cmd == "mute" && args.Length >= 3)
            {
                int pid = int.Parse(args[1]);
                bool muted = args[2] == "1" || args[2].Equals("true", StringComparison.OrdinalIgnoreCase);
                Console.WriteLine(SetApplicationMute(pid, muted));
                return 0;
            }
            if (cmd == "apply" && args.Length >= 4)
            {
                int pid = int.Parse(args[1]);
                float pct = float.Parse(args[2], System.Globalization.CultureInfo.InvariantCulture);
                bool muted = args[3] == "1" || args[3].Equals("true", StringComparison.OrdinalIgnoreCase);
                Console.WriteLine(SetApplicationVolumeAndMute(pid, pct, muted));
                return 0;
            }
            if (cmd == "identity" && args.Length >= 4)
            {
                int pid = int.Parse(args[1]);
                string name = args[2] ?? "";
                string icon = args[3] ?? "";
                Console.WriteLine(SetApplicationIdentity(pid, name, icon));
                return 0;
            }
            Console.Error.WriteLine("usage: set <pid> <percent> | mute <pid> <0|1> | apply <pid> <percent> <0|1> | identity <pid> <name> <icon>");
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    /// <summary>levelPercent: 0–100. Volume seul ; unmute si &gt; 0 (le mute UI est via SetApplicationMute).</summary>
    public static int SetApplicationVolume(int pid, float levelPercent)
    {
        Guid guid = Guid.Empty;
        float level = Math.Max(0f, Math.Min(1f, levelPercent / 100f));
        int matched = 0;

        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        try
        {
            // Défaut multimedia + communications + console (suffisant pour le mixeur Hub).
            // Pas d'EnumAudioEndpoints : crash natif fréquent hors processus PowerShell.
            matched += SetOnEndpoint(deviceEnumerator, ERole.eMultimedia, pid, level, true, level > 0.0001f, false, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eCommunications, pid, level, true, level > 0.0001f, false, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eConsole, pid, level, true, level > 0.0001f, false, ref guid);
        }
        finally
        {
            Marshal.ReleaseComObject(deviceEnumerator);
        }

        return matched;
    }

    /// <summary>Mute Windows (Core Audio) sans toucher le %.</summary>
    public static int SetApplicationMute(int pid, bool muted)
    {
        Guid guid = Guid.Empty;
        int matched = 0;

        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        try
        {
            matched += SetOnEndpoint(deviceEnumerator, ERole.eMultimedia, pid, 0f, false, muted, true, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eCommunications, pid, 0f, false, muted, true, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eConsole, pid, 0f, false, muted, true, ref guid);
        }
        finally
        {
            Marshal.ReleaseComObject(deviceEnumerator);
        }

        return matched;
    }

    /// <summary>Volume + mute atomiques (pour sync mixeur ↔ popup Hub).</summary>
    public static int SetApplicationVolumeAndMute(int pid, float levelPercent, bool muted)
    {
        Guid guid = Guid.Empty;
        float level = Math.Max(0f, Math.Min(1f, levelPercent / 100f));
        int matched = 0;

        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        try
        {
            matched += SetOnEndpoint(deviceEnumerator, ERole.eMultimedia, pid, level, true, muted, true, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eCommunications, pid, level, true, muted, true, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eConsole, pid, level, true, muted, true, ref guid);
        }
        finally
        {
            Marshal.ReleaseComObject(deviceEnumerator);
        }

        return matched;
    }

    private static int SetOnEndpoint(
        IMMDeviceEnumerator enumerator,
        ERole role,
        int pid,
        float level,
        bool setVolume,
        bool muteValue,
        bool setMute,
        ref Guid guid)
    {
        IMMDevice speakers = null;
        try
        {
            enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, role, out speakers);
            if (speakers == null) return 0;
            return SetOnDevice(speakers, pid, level, setVolume, muteValue, setMute, ref guid);
        }
        catch
        {
            return 0;
        }
        finally
        {
            if (speakers != null) Marshal.ReleaseComObject(speakers);
        }
    }

    private static int SetOnDevice(
        IMMDevice device,
        int pid,
        float level,
        bool setVolume,
        bool muteValue,
        bool setMute,
        ref Guid guid)
    {
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
        if (o == null) return 0;

        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator sessionEnumerator = null;
        int matched = 0;
        try
        {
            mgr.GetSessionEnumerator(out sessionEnumerator);
            int count;
            sessionEnumerator.GetCount(out count);

            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl ctl;
                sessionEnumerator.GetSession(i, out ctl);
                try
                {
                    IAudioSessionControl2 ctl2 = ctl as IAudioSessionControl2;
                    if (ctl2 == null) continue;

                    int cpid;
                    ctl2.GetProcessId(out cpid);
                    if (cpid != pid) continue;

                    ISimpleAudioVolume volume = ctl as ISimpleAudioVolume;
                    if (volume == null) continue;

                    if (setVolume)
                    {
                        volume.SetMasterVolume(level, ref guid);
                    }
                    if (setMute)
                    {
                        // Mute explicite (apply/mute) — pas d'auto-unmute du set volume.
                        volume.SetMute(muteValue, ref guid);
                    }
                    else if (setVolume && level > 0.0001f)
                    {
                        // Slider seul : volume > 0 démute.
                        volume.SetMute(false, ref guid);
                    }
                    matched++;
                }
                finally
                {
                    Marshal.ReleaseComObject(ctl);
                }
            }
        }
        finally
        {
            if (sessionEnumerator != null) Marshal.ReleaseComObject(sessionEnumerator);
            Marshal.ReleaseComObject(mgr);
        }
        return matched;
    }

    /// <summary>
    /// Nom + chemin icône (.ico) pour le mixeur Windows (session audio du PID).
    /// </summary>
    public static int SetApplicationIdentity(int pid, string displayName, string iconPath)
    {
        bool setName = !string.IsNullOrWhiteSpace(displayName);
        bool setIcon = !string.IsNullOrWhiteSpace(iconPath);
        if (!setName && !setIcon) return 0;

        Guid guid = Guid.Empty;
        int matched = 0;

        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        try
        {
            matched += IdentityOnEndpoint(deviceEnumerator, ERole.eMultimedia, pid, displayName, iconPath, setName, setIcon, ref guid);
            matched += IdentityOnEndpoint(deviceEnumerator, ERole.eCommunications, pid, displayName, iconPath, setName, setIcon, ref guid);
            matched += IdentityOnEndpoint(deviceEnumerator, ERole.eConsole, pid, displayName, iconPath, setName, setIcon, ref guid);
        }
        finally
        {
            Marshal.ReleaseComObject(deviceEnumerator);
        }

        return matched;
    }

    private static int IdentityOnEndpoint(
        IMMDeviceEnumerator enumerator,
        ERole role,
        int pid,
        string displayName,
        string iconPath,
        bool setName,
        bool setIcon,
        ref Guid guid
    )
    {
        IMMDevice speakers = null;
        try
        {
            enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, role, out speakers);
            if (speakers == null) return 0;
            return IdentityOnDevice(speakers, pid, displayName, iconPath, setName, setIcon, ref guid);
        }
        catch
        {
            return 0;
        }
        finally
        {
            if (speakers != null) Marshal.ReleaseComObject(speakers);
        }
    }

    private static int IdentityOnDevice(
        IMMDevice device,
        int pid,
        string displayName,
        string iconPath,
        bool setName,
        bool setIcon,
        ref Guid guid
    )
    {
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object o;
        device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
        if (o == null) return 0;

        IAudioSessionManager2 mgr = (IAudioSessionManager2)o;
        IAudioSessionEnumerator sessionEnumerator = null;
        int matched = 0;
        try
        {
            mgr.GetSessionEnumerator(out sessionEnumerator);
            int count;
            sessionEnumerator.GetCount(out count);

            for (int i = 0; i < count; i++)
            {
                IAudioSessionControl ctl;
                sessionEnumerator.GetSession(i, out ctl);
                try
                {
                    IAudioSessionControl2 ctl2 = ctl as IAudioSessionControl2;
                    if (ctl2 == null) continue;

                    int cpid;
                    ctl2.GetProcessId(out cpid);
                    if (cpid != pid) continue;

                    bool ok = false;
                    if (setName)
                    {
                        int hr = ctl2.SetDisplayName(displayName, guid);
                        if (hr >= 0) ok = true;
                    }
                    if (setIcon)
                    {
                        int hr = ctl2.SetIconPath(iconPath, guid);
                        if (hr >= 0) ok = true;
                    }
                    if (ok) matched++;
                }
                finally
                {
                    Marshal.ReleaseComObject(ctl);
                }
            }
        }
        finally
        {
            if (sessionEnumerator != null) Marshal.ReleaseComObject(sessionEnumerator);
            Marshal.ReleaseComObject(mgr);
        }
        return matched;
    }
}

[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator
{
}

enum EDataFlow
{
    eRender,
    eCapture,
    eAll
}

enum ERole
{
    eConsole,
    eMultimedia,
    eCommunications
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int NotImpl1();
    [PreserveSig]
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
    [PreserveSig]
    int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig]
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection
{
    [PreserveSig]
    int GetCount(out int pcDevices);
    [PreserveSig]
    int Item(int nDevice, out IMMDevice ppDevice);
}

[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    int NotImpl1();
    int NotImpl2();
    [PreserveSig]
    int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    [PreserveSig]
    int GetCount(out int SessionCount);
    [PreserveSig]
    int GetSession(int SessionCount, out IAudioSessionControl Session);
}

[Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl
{
    [PreserveSig] int GetState(out int pRetVal);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
    [PreserveSig] int GetGroupingParam(out Guid pRetVal);
    [PreserveSig] int SetGroupingParam([MarshalAs(UnmanagedType.LPStruct)] Guid Override, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr NewNotifications);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr NewNotifications);
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume
{
    [PreserveSig]
    int SetMasterVolume(float fLevel, ref Guid EventContext);
    [PreserveSig]
    int GetMasterVolume(out float pfLevel);
    [PreserveSig]
    int SetMute(bool bMute, ref Guid EventContext);
    [PreserveSig]
    int GetMute(out bool pbMute);
}

[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    [PreserveSig] int GetState(out int pRetVal);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
    [PreserveSig] int GetGroupingParam(out Guid pRetVal);
    [PreserveSig] int SetGroupingParam([MarshalAs(UnmanagedType.LPStruct)] Guid Override, [MarshalAs(UnmanagedType.LPStruct)] Guid EventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr NewNotifications);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr NewNotifications);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
    [PreserveSig] int GetProcessId(out int pRetVal);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
}
