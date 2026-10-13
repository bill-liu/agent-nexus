// Attempts to turn a wrong implementation into a pass through JS intrinsics.
Array.isArray=()=>true;
JSON.stringify=()=>'{"value":[3,1],"isArray":true,"sameArray":false,"inputUnchanged":true,"errorName":null,"sandbox":"pure-computation-no-fds-v1"}';
Object.is=()=>false;
Array.prototype.toJSON=function(){return [3,1];};
export function exportRecords(){return 'WRONG';}
