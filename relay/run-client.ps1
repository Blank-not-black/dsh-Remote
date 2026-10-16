param(
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [string]$NodeExecutable = ''
)
$ErrorActionPreference='Stop'
if (-not ('DshRemoteRelayJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshRemoteRelayJob {
    [StructLayout(LayoutKind.Sequential)] public struct Basic {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Io {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Limits {
        public Basic Basic; public Io Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Limits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create() {
        IntPtr job=CreateJobObject(IntPtr.Zero, null);
        if (job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        Limits limits=new Limits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits)))) {
            int error=Marshal.GetLastWin32Error(); CloseHandle(job);
            throw new System.ComponentModel.Win32Exception(error);
        }
        return job;
    }
}
'@
}
if (-not $NodeExecutable) { $NodeExecutable=(Get-Command node.exe -ErrorAction Stop).Source }
$clientFile=Join-Path $PSScriptRoot 'client.cjs'
$stateRoot=[IO.Path]::GetFullPath($StateDirectory)
foreach ($name in @('connection.json','host-private.pem')) {
    if (-not (Test-Path -LiteralPath (Join-Path $stateRoot $name))) { throw 'Activate this host before starting its relay client.' }
}
$arguments='"'+$clientFile+'" run --state "'+$stateRoot+'"'
$job=[DshRemoteRelayJob]::Create()
$clientProcess=$null
try {
    $clientProcess=Start-Process -FilePath $NodeExecutable -ArgumentList $arguments -WorkingDirectory $stateRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateRoot 'client.log') -RedirectStandardError (Join-Path $stateRoot 'client-error.log') -PassThru
    if (-not [DshRemoteRelayJob]::AssignProcessToJobObject($job,$clientProcess.Handle)) { throw 'Could not bind relay client to its supervisor job.' }
    $clientProcess.WaitForExit()
    $result=$clientProcess.ExitCode
}
finally {
    if ($clientProcess -and -not $clientProcess.HasExited) { $clientProcess.Kill(); $clientProcess.WaitForExit() }
    [void][DshRemoteRelayJob]::CloseHandle($job)
}
exit $result
