export interface ResourceLimits {cpuPercent:number;memoryBytes:number;pids:number;diskBytes?:number}
export function resourceProperties(limits:ResourceLimits):string[] {
 if(limits.diskBytes!==undefined) throw new Error('DISK_QUOTA_UNSUPPORTED');
 if(!Number.isSafeInteger(limits.cpuPercent)||limits.cpuPercent<1||limits.cpuPercent>800||!Number.isSafeInteger(limits.memoryBytes)||limits.memoryBytes<64*1024*1024||limits.memoryBytes>16*1024**3||!Number.isSafeInteger(limits.pids)||limits.pids<1||limits.pids>4096) throw new Error('RESOURCE_LIMIT_INVALID');
 return [`CPUQuota=${limits.cpuPercent}%`,`MemoryMax=${limits.memoryBytes}`,'MemorySwapMax=0',`TasksMax=${limits.pids}`,'KillMode=control-group','Delegate=no','NoNewPrivileges=yes'];
}
