
export function requiredEnv(name: string): string {
    const value = process.env[name];

    if (value === undefined || value === "") {
        throw new Error(`${name} env is required`);
    }

    return value;
}