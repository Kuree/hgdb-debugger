export function convertToDot(name: string): string {
    // convert notations like a[0][1] to a.0.1
    const regex: RegExp = /\[(\d+)]/sg;
    const sub = `\.$1`;
    return name.replace(regex, sub);
}

export function convertToDotMap(values: Map<string, string>): Map<string, string> {
    let result = new Map<string, string>();
    values.forEach((value: string, key: string) => {
        const new_key = convertToDot(key);
        result.set(new_key, value);
    });

    return result;
}