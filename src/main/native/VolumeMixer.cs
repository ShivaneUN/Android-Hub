using System;
using System.Runtime.InteropServices;

/// <summary>
/// Volume Windows par PID (Core Audio ISimpleAudioVolume) — toutes les sorties render.
/// </summary>
public static class HubVolumeMixer
{
    /// <summary>levelPercent: 0–100. Retourne le nombre de sessions audio matchées.</summary>
    public static int SetApplicationVolume(int pid, float levelPercent)
    {
        Guid guid = Guid.Empty;
        float level = Math.Max(0f, Math.Min(1f, levelPercent / 100f));
        int matched = 0;

        IMMDeviceEnumerator deviceEnumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        try
        {
            // Défaut multimedia + communications
            matched += SetOnEndpoint(deviceEnumerator, ERole.eMultimedia, pid, level, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eCommunications, pid, level, ref guid);
            matched += SetOnEndpoint(deviceEnumerator, ERole.eConsole, pid, level, ref guid);

            // Toutes les sorties actives (cas multi-carte / HDMI / casque)
            IMMDeviceCollection coll;
            deviceEnumerator.EnumAudioEndpoints(EDataFlow.eRender, 1 /* DEVICE_STATE_ACTIVE */, out coll);
            if (coll != null)
            {
                int n;
                coll.GetCount(out n);
                for (int i = 0; i < n; i++)
                {
                    IMMDevice device;
                    coll.Item(i, out device);
                    try
                    {
                        matched += SetOnDevice(device, pid, level, ref guid);
                    }
                    finally
                    {
                        if (device != null) Marshal.ReleaseComObject(device);
                    }
                }
                Marshal.ReleaseComObject(coll);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(deviceEnumerator);
        }

        return matched;
    }

    private static int SetOnEndpoint(IMMDeviceEnumerator enumerator, ERole role, int pid, float level, ref Guid guid)
    {
        IMMDevice speakers = null;
        try
        {
            enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, role, out speakers);
            if (speakers == null) return 0;
            return SetOnDevice(speakers, pid, level, ref guid);
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

    private static int SetOnDevice(IMMDevice device, int pid, float level, ref Guid guid)
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

                    volume.SetMasterVolume(level, ref guid);
                    volume.SetMute(level <= 0.0001f, ref guid);
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
