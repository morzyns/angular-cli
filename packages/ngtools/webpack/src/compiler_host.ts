/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {
  Path,
  getSystemPath,
  isAbsolute,
  join,
  normalize,
  virtualFs,
} from '@angular-devkit/core';
import { Stats } from 'fs';
import * as ts from 'typescript';
import { WebpackResourceLoader } from './resource_loader';


export interface OnErrorFn {
  (message: string): void;
}


const dev = Math.floor(Math.random() * 10000);


export class WebpackCompilerHost implements ts.CompilerHost {
  private _syncHost: virtualFs.SyncDelegateHost;
  private _changedFiles = new Set<string>();
  private _basePath: Path;
  private _resourceLoader?: WebpackResourceLoader;

  constructor(
    private _options: ts.CompilerOptions,
    basePath: string,
    host: virtualFs.Host,
  ) {
    this._syncHost = new virtualFs.SyncDelegateHost(new virtualFs.CordHost(host));
    this._basePath = normalize(basePath);
  }

  private get virtualFiles(): Path[] {
    return (this._syncHost.delegate as virtualFs.CordHost)
      .records()
      .filter(record => record.kind === 'create')
      .map((record: virtualFs.CordHostCreate) => record.path);
  }

  denormalizePath(path: string) {
    return getSystemPath(normalize(path));
  }

  resolve(path: string): Path {
    const p = normalize(path);
    if (isAbsolute(p)) {
      return p;
    } else {
      return join(this._basePath, p);
    }
  }

  resetChangedFileTracker() {
    this._changedFiles.clear();
  }

  getChangedFilePaths(): string[] {
    return [...this._changedFiles];
  }

  getNgFactoryPaths(): string[] {
    return this.virtualFiles
      .filter(fileName => fileName.endsWith('.ngfactory.js') || fileName.endsWith('.ngstyle.js'))
      // These paths are used by the virtual file system decorator so we must denormalize them.
      .map(path => this.denormalizePath(path));
  }

  invalidate(fileName: string): void {
    const fullPath = this.resolve(fileName);

    if (this.fileExists(fileName)) {
      this._changedFiles.add(fullPath);
    }
  }

  fileExists(fileName: string, delegate = true): boolean {
    const p = this.resolve(fileName);

    const exists = this._syncHost.exists(p) && this._syncHost.isFile(p);
    if (delegate) {
      return exists;
    } else {
      const backend = new virtualFs.SyncDelegateHost(
        (this._syncHost.delegate as virtualFs.CordHost).backend as virtualFs.Host,
      );

      return exists && !(backend.exists(p) && backend.isFile(p));
    }
  }

  readFile(fileName: string): string | undefined {
    const filePath = this.resolve(fileName);
    if (!this._syncHost.exists(filePath) || !this._syncHost.isFile(filePath)) {
      return undefined;
    }

    return virtualFs.fileBufferToString(this._syncHost.read(filePath));
  }

  readFileBuffer(fileName: string): Buffer | undefined {
    const filePath = this.resolve(fileName);
    if (!this._syncHost.exists(filePath) || !this._syncHost.isFile(filePath)) {
      return undefined;
    }

    return Buffer.from(this._syncHost.read(filePath));
  }

  stat(path: string): Stats | null {
    const p = this.resolve(path);

    const stats = this._syncHost.exists(p) && this._syncHost.stat(p);
    if (!stats) {
      return null;
    }

    return {
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSymbolicLink: () => false,
      isSocket: () => false,
      dev,
      ino: Math.floor(Math.random() * 100000),
      mode: parseInt('777', 8),
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      blksize: 512,
      blocks: Math.ceil(stats.size / 512),
      atimeMs: stats.atime.getTime(),
      mtimeMs: stats.mtime.getTime(),
      ctimeMs: stats.ctime.getTime(),
      birthtimeMs: stats.birthtime.getTime(),
      ...stats,
    };
  }

  directoryExists(directoryName: string): boolean {
    const p = this.resolve(directoryName);

    return this._syncHost.exists(p) && this._syncHost.isDirectory(p);
  }

  getDirectories(path: string): string[] {
    const p = this.resolve(path);

    let delegated: string[];
    try {
      delegated = this._syncHost.list(p).filter(x => {
        try {
          return this._syncHost.isDirectory(join(p, x));
        } catch {
          return false;
        }
      });
    } catch {
      delegated = [];
    }

    return delegated;
  }

  getSourceFile(fileName: string, languageVersion: ts.ScriptTarget, onError?: OnErrorFn) {
    try {
      const content = this.readFile(fileName);
      if (content != undefined) {
        return ts.createSourceFile(workaroundResolve(fileName), content, languageVersion, true);
      }
    } catch (e) {
      if (onError) {
        onError(e.message);
      }
    }

    return undefined;
  }

  getDefaultLibFileName(options: ts.CompilerOptions) {
    return ts.createCompilerHost(options).getDefaultLibFileName(options);
  }

  // This is due to typescript CompilerHost interface being weird on writeFile. This shuts down
  // typings in WebStorm.
  get writeFile() {
    return (
      fileName: string,
      data: string,
      _writeByteOrderMark: boolean,
      onError?: (message: string) => void,
      _sourceFiles?: ReadonlyArray<ts.SourceFile>,
    ): void => {
      const p = this.resolve(fileName);

      try {
        this._syncHost.write(p, virtualFs.stringToFileBuffer(data));
      } catch (e) {
        if (onError) {
          onError(e.message);
        }
      }
    };
  }

  getCurrentDirectory(): string {
    return this._basePath;
  }

  getCanonicalFileName(fileName: string): string {
    const path = this.resolve(fileName);

    return this.useCaseSensitiveFileNames ? path : path.toLowerCase();
  }

  useCaseSensitiveFileNames(): boolean {
    return !process.platform.startsWith('win32');
  }

  getNewLine(): string {
    return '\n';
  }

  setResourceLoader(resourceLoader: WebpackResourceLoader) {
    this._resourceLoader = resourceLoader;
  }

  readResource(fileName: string) {
    if (this._resourceLoader) {
      // These paths are meant to be used by the loader so we must denormalize them.
      const denormalizedFileName = this.denormalizePath(normalize(fileName));

      return this._resourceLoader.get(denormalizedFileName);
    } else {
      return this.readFile(fileName);
    }
  }
}


// `TsCompilerAotCompilerTypeCheckHostAdapter` in @angular/compiler-cli seems to resolve module
// names directly via `resolveModuleName`, which prevents full Path usage.
// To work around this we must provide the same path format as TS internally uses in
// the SourceFile paths.
export function workaroundResolve(path: Path | string) {
  return getSystemPath(normalize(path)).replace(/\\/g, '/');
}
