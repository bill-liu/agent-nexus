export interface QuitAdapter {stopAdmissions():Promise<void>;resumeAdmissions():Promise<void>;saveAndStop():Promise<string[]>;}
export class QuitCoordinator {
 state:'idle'|'confirming'|'saving'='idle';private pending:Promise<void>|undefined;
 constructor(private readonly adapter:QuitAdapter){}
 async begin():Promise<void>{if(this.state!=='idle'){await this.pending;return;}this.state='confirming';this.pending=this.adapter.stopAdmissions();try{await this.pending;}catch(error){this.state='idle';throw error;}finally{this.pending=undefined;}}
 async cancel():Promise<void>{await this.pending;if(this.state!=='confirming')return;await this.adapter.resumeAdmissions();this.state='idle';}
 async save():Promise<string[]>{await this.pending;if(this.state!=='confirming')throw Error('QUIT_NOT_CONFIRMED');this.state='saving';try{return await this.adapter.saveAndStop();}catch(error){this.state='confirming';throw error;}}
}
