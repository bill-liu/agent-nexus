// Small fixture assertion helper for the fixed generated JSON Schema corpus, not an application validator.
export function matchesSchema(value:unknown,schema:any,root=schema):boolean {
 if(schema.$ref)return matchesSchema(value,schema.$ref.split('/').slice(1).reduce((v:any,k:string)=>v[k],root),root);
 if(schema.allOf&&!schema.allOf.every((s:any)=>matchesSchema(value,s,root)))return false;
 if(schema.anyOf&&!schema.anyOf.some((s:any)=>matchesSchema(value,s,root)))return false;
 if(schema.oneOf&&schema.oneOf.filter((s:any)=>matchesSchema(value,s,root)).length!==1)return false;
 if(schema.enum&&!schema.enum.some((x:any)=>JSON.stringify(x)===JSON.stringify(value)))return false;
 if(schema.type){const types=Array.isArray(schema.type)?schema.type:[schema.type];if(!types.some((t:string)=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?!!value&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isSafeInteger(value):typeof value===t))return false;}
 if(value&&typeof value==='object'&&!Array.isArray(value)){const o=value as Record<string,unknown>;if(schema.required?.some((k:string)=>!Object.hasOwn(o,k)))return false;for(const [k,v]of Object.entries(o)){if(schema.properties?.[k]&&!matchesSchema(v,schema.properties[k],root))return false;if(schema.additionalProperties===false&&!schema.properties?.[k])return false;}}
 if(Array.isArray(value)&&schema.items&&!value.every(v=>matchesSchema(v,schema.items,root)))return false;
 if(typeof value==='number'&&schema.minimum!==undefined&&value<schema.minimum)return false;return true;
}
