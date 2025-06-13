import React, { createContext, useContext, useState } from "react";

const FileContext = createContext();

export const FileProvider = ({ children, dataURL }) => {
  const [fileMap, setFileMap] = useState(new Map());
  const [customDataURL, setCustomDataURL] = useState(null); // override only if needed

  const effectiveDataURL = customDataURL || dataURL;

  const handleFolderUpload = (fileList) => {
    const map = new Map();
    for (const file of fileList) {
      map.set(file.webkitRelativePath, file);
    }
    setFileMap(map);
    console.log("📁 Uploaded paths:", [...map.keys()]);
  };

  const clearFileMap = () => {
    setFileMap(new Map());
    console.log("Cleared uploaded files.");
  };

  const readTextFile = async (filename) => {
    const file = fileMap.get(filename);
    if (!file) throw new Error(`File not found: ${filename}`);
    return await file.text();
  };

  const readJSONFile = async (filename) => {
    const text = await readTextFile(filename);
    return JSON.parse(text);
  };

  return (
    <FileContext.Provider
      value={{
        fileMap,
        handleFolderUpload,
        clearFileMap,
        readTextFile,
        readJSONFile,
        dataURL: effectiveDataURL,
        setDataURL: setCustomDataURL,
      }}
    >
      {children}
    </FileContext.Provider>
  );
};

export const useFileContext = () => useContext(FileContext);
